import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

const publicIpv6Range = ipaddr.IPv6.parseCIDR("2000::/3");

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type AllowedDestination = {
  baseUrl: string;
  origin: string;
  hostname: string;
  address: string;
  family: 4 | 6;
};

export class UpstreamPolicyError extends Error {
  readonly code: "INVALID_TARGET" | "INVALID_ALLOWLIST" | "TARGET_NOT_ALLOWED" | "DNS_UNAVAILABLE" | "NON_PUBLIC_ADDRESS";

  constructor(code: UpstreamPolicyError["code"]) {
    super(code);
    this.name = "UpstreamPolicyError";
    this.code = code;
  }
}

function parseHttpsUrl(value: string, code: "INVALID_TARGET" | "INVALID_ALLOWLIST"): URL {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f?#]/.test(value)) {
    throw new UpstreamPolicyError(code);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamPolicyError(code);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.startsWith("[") ||
    isIP(url.hostname) !== 0
  ) {
    throw new UpstreamPolicyError(code);
  }
  return url;
}

export function normalizeAllowedOrigin(value: string): string {
  const url = parseHttpsUrl(value, "INVALID_ALLOWLIST");
  if (url.pathname !== "/") throw new UpstreamPolicyError("INVALID_ALLOWLIST");
  return url.origin;
}

function isPublicAddress({ address, family }: ResolvedAddress): boolean {
  if (isIP(address) !== family) return false;
  try {
    const normalized = ipaddr.process(address);
    if (normalized.range() !== "unicast") return false;
    if (normalized.kind() === "ipv6") {
      return ipaddr.subnetMatch(normalized, { publicIpv6: publicIpv6Range }, "none") === "publicIpv6";
    }
    return true;
  } catch {
    return false;
  }
}

export const resolveDns: AddressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export async function resolveAllowedDestination(
  baseUrl: string,
  allowedOrigins: Iterable<string>,
  resolver: AddressResolver = resolveDns,
): Promise<AllowedDestination> {
  const url = parseHttpsUrl(baseUrl, "INVALID_TARGET");
  const origins = new Set(Array.from(allowedOrigins, normalizeAllowedOrigin));
  if (!origins.has(url.origin)) throw new UpstreamPolicyError("TARGET_NOT_ALLOWED");

  let records: readonly ResolvedAddress[];
  try {
    records = await resolver(url.hostname);
  } catch {
    throw new UpstreamPolicyError("DNS_UNAVAILABLE");
  }
  if (records.length === 0) throw new UpstreamPolicyError("DNS_UNAVAILABLE");
  if (!records.every(isPublicAddress)) throw new UpstreamPolicyError("NON_PUBLIC_ADDRESS");

  const selected = records[0];
  return {
    baseUrl: url.toString(),
    origin: url.origin,
    hostname: url.hostname,
    address: selected.address,
    family: selected.family,
  };
}
