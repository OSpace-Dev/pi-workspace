import https from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { PassThrough } from "node:stream";
import ipaddr from "ipaddr.js";
import type { AllowedDestination } from "./upstream-policy.ts";

export type TransportErrorCode =
  | "INVALID_DESTINATION"
  | "ADDRESS_MISMATCH"
  | "CONNECTION_FAILED"
  | "FIRST_RESPONSE_TIMEOUT"
  | "IDLE_TIMEOUT"
  | "CANCELLED"
  | "REDIRECT_REJECTED"
  | "UPSTREAM_STATUS"
  | "INVALID_CONTENT_TYPE"
  | "STREAM_FAILURE";

export class UpstreamTransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode) {
    super(code);
    this.name = "UpstreamTransportError";
    this.code = code;
  }
}

export type StreamOptions = {
  signal?: AbortSignal;
  credential?: string;
  firstResponseTimeoutMs: number;
  idleTimeoutMs: number;
};

function transportError(error: unknown, fallback: TransportErrorCode, signal?: AbortSignal): UpstreamTransportError {
  if (error instanceof UpstreamTransportError) return error;
  return new UpstreamTransportError(signal?.aborted ? "CANCELLED" : fallback);
}

function matchesSelectedAddress(actual: string | undefined, destination: AllowedDestination): boolean {
  if (!actual || isIP(actual) !== destination.family) return false;
  try {
    return ipaddr.parse(actual).toNormalizedString() === ipaddr.parse(destination.address).toNormalizedString();
  } catch {
    return false;
  }
}

export async function postChatCompletionStream(
  destination: AllowedDestination,
  body: Uint8Array,
  options: StreamOptions,
): Promise<PassThrough> {
  const base = new URL(destination.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.hostname !== destination.hostname ||
    base.origin !== destination.origin ||
    isIP(destination.address) !== destination.family ||
    !Number.isSafeInteger(options.firstResponseTimeoutMs) ||
    options.firstResponseTimeoutMs <= 0 ||
    !Number.isSafeInteger(options.idleTimeoutMs) ||
    options.idleTimeoutMs <= 0 ||
    (options.credential !== undefined && (!options.credential || /[^\x20-\x7e]/.test(options.credential)))
  ) {
    throw new UpstreamTransportError("INVALID_DESTINATION");
  }

  const agent = new https.Agent({
    keepAlive: false,
    maxCachedSessions: 0,
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) {
        callback(null, [{ address: destination.address, family: destination.family }]);
      } else {
        callback(null, destination.address, destination.family);
      }
    },
  });
  const path = `${base.pathname.replace(/\/$/, "")}/chat/completions`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request({
      hostname: destination.hostname,
      port: base.port || 443,
      path,
      method: "POST",
      agent,
      signal: options.signal,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "content-length": body.byteLength,
        ...(options.credential === undefined ? {} : { authorization: `Bearer ${options.credential}` }),
      },
    }, (response: IncomingMessage) => {
      clearTimeout(firstResponseTimer);
      const status = response.statusCode ?? 0;
      const contentType = response.headers["content-type"];
      const rejectResponse = (code: TransportErrorCode): void => {
        settled = true;
        response.destroy();
        agent.destroy();
        reject(new UpstreamTransportError(code));
      };
      if (status >= 300 && status < 400) return rejectResponse("REDIRECT_REJECTED");
      if (status < 200 || status >= 300) return rejectResponse("UPSTREAM_STATUS");
      if (typeof contentType !== "string" || !/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType)) {
        return rejectResponse("INVALID_CONTENT_TYPE");
      }

      const stream = new PassThrough();
      response.setTimeout(options.idleTimeoutMs, () => {
        response.destroy(new UpstreamTransportError("IDLE_TIMEOUT"));
      });
      response.on("error", (error) => {
        stream.destroy(transportError(error, "STREAM_FAILURE", options.signal));
      });
      response.on("close", () => {
        if (!response.complete && !stream.destroyed) {
          stream.destroy(new UpstreamTransportError(options.signal?.aborted ? "CANCELLED" : "STREAM_FAILURE"));
        }
        agent.destroy();
      });
      stream.on("close", () => {
        response.destroy();
        agent.destroy();
      });
      settled = true;
      response.pipe(stream);
      resolve(stream);
    });

    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        if (!matchesSelectedAddress(socket.remoteAddress, destination)) {
          request.destroy(new UpstreamTransportError("ADDRESS_MISMATCH"));
        }
      });
    });

    const firstResponseTimer = setTimeout(() => {
      request.destroy(new UpstreamTransportError("FIRST_RESPONSE_TIMEOUT"));
    }, options.firstResponseTimeoutMs);
    request.on("error", (error) => {
      clearTimeout(firstResponseTimer);
      agent.destroy();
      if (!settled) reject(transportError(error, "CONNECTION_FAILED", options.signal));
    });
    request.end(body);
  });
}
