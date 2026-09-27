import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAllowedOrigin,
  resolveAllowedDestination,
  UpstreamPolicyError,
  type AddressResolver,
  type ResolvedAddress,
} from "./upstream-policy.ts";

const publicIpv4: ResolvedAddress = { address: "8.8.8.8", family: 4 };
const publicIpv6: ResolvedAddress = { address: "2606:4700:4700::1111", family: 6 };
const resolved = (addresses: readonly ResolvedAddress[]): AddressResolver => async () => addresses;
const allowed = ["https://api.example.test"];

async function expectCode(action: () => Promise<unknown>, code: UpstreamPolicyError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof UpstreamPolicyError && error.code === code);
}

test("normalizes and exactly matches an approved HTTPS origin", async () => {
  assert.equal(normalizeAllowedOrigin("https://API.Example.Test:443/"), "https://api.example.test");
  const destination = await resolveAllowedDestination(
    "https://API.Example.Test:443/v1",
    allowed,
    resolved([publicIpv4, publicIpv6]),
  );
  assert.deepEqual(destination, {
    baseUrl: "https://api.example.test/v1",
    origin: "https://api.example.test",
    hostname: "api.example.test",
    address: "8.8.8.8",
    family: 4,
  });
});

test("rejects origin lookalikes and unapproved ports before DNS", async () => {
  let called = false;
  const resolver: AddressResolver = async () => {
    called = true;
    return [publicIpv4];
  };
  for (const target of [
    "https://api.example.test.evil.test/v1",
    "https://sub.api.example.test/v1",
    "https://api.example.test:8443/v1",
  ]) {
    await expectCode(() => resolveAllowedDestination(target, allowed, resolver), "TARGET_NOT_ALLOWED");
  }
  assert.equal(called, false);
});

test("rejects malformed target URLs and allowlist entries", async () => {
  for (const target of [
    "http://api.example.test/v1",
    "https://name:secret@api.example.test/v1",
    "https://api.example.test/v1?token=x",
    "https://api.example.test/v1?",
    "https://api.example.test/v1#fragment",
    "https://api.example.test/v1#",
    "https://127.0.0.1/v1",
    "https://[2606:4700:4700::1111]/v1",
    " https://api.example.test/v1",
    "https://api.example.test/\n/v1",
  ]) {
    await expectCode(() => resolveAllowedDestination(target, allowed, resolved([publicIpv4])), "INVALID_TARGET");
  }
  for (const origin of ["http://api.example.test", "https://api.example.test/v1", "https://api.example.test?x=1", "https://api.example.test?", "https://api.example.test#"]) {
    assert.throws(() => normalizeAllowedOrigin(origin), { code: "INVALID_ALLOWLIST" });
  }
  const encodedPath = await resolveAllowedDestination("https://api.example.test/v1%3F", allowed, resolved([publicIpv4]));
  assert.equal(encodedPath.baseUrl, "https://api.example.test/v1%3F");
});

test("rejects DNS failure, empty records, and every non-public address class", async () => {
  await expectCode(() => resolveAllowedDestination("https://api.example.test/v1", allowed, async () => {
    throw new Error("resolver details must not escape");
  }), "DNS_UNAVAILABLE");
  await expectCode(() => resolveAllowedDestination("https://api.example.test/v1", allowed, resolved([])), "DNS_UNAVAILABLE");
  for (const address of [
    { address: "127.0.0.1", family: 4 },
    { address: "10.0.0.1", family: 4 },
    { address: "100.64.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
    { address: "192.0.2.1", family: 4 },
    { address: "224.0.0.1", family: 4 },
    { address: "::1", family: 6 },
    { address: "fc00::1", family: 6 },
    { address: "fe80::1", family: 6 },
    { address: "2001:db8::1", family: 6 },
    { address: "ff02::1", family: 6 },
    { address: "::ffff:127.0.0.1", family: 6 },
    { address: "not-an-address", family: 4 },
    { address: "8.8.8.8", family: 6 },
  ] as ResolvedAddress[]) {
    await expectCode(() => resolveAllowedDestination("https://api.example.test/v1", allowed, resolved([address])), "NON_PUBLIC_ADDRESS");
  }
  await expectCode(() => resolveAllowedDestination("https://api.example.test/v1", allowed, resolved([publicIpv4, { address: "10.0.0.1", family: 4 }])), "NON_PUBLIC_ADDRESS");
});

test("accepts a public IPv6 result for a DNS hostname", async () => {
  const destination = await resolveAllowedDestination("https://api.example.test/v1", allowed, resolved([publicIpv6]));
  assert.equal(destination.address, publicIpv6.address);
  assert.equal(destination.family, 6);
});
