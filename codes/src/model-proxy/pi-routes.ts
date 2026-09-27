import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ActiveStreams } from "./active-streams.ts";
import { getModelConnection, listModelOrigins, readModelCredential } from "./connection-store.ts";
import { postChatCompletionStream, UpstreamTransportError } from "./https-transport.ts";
import { PiRequestError, validatePiRequest } from "./pi-request.ts";
import { findAuthorizedTaskGrant } from "./proxy-task-store.ts";
import { resolveAllowedDestination, UpstreamPolicyError } from "./upstream-policy.ts";

function errorBody(code: string): { error: { code: string; message: string } } {
  return { error: { code, message: code } };
}

function doneGuard(): Transform {
  let tail = "";
  let seenDone = false;
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return callback(new UpstreamTransportError("STREAM_FAILURE"));
      const current = tail + chunk.toString("utf8");
      if (current.includes("data: [DONE]\n\n") || current.includes("data: [DONE]\r\n\r\n")) seenDone = true;
      tail = current.slice(-32);
      callback(null, chunk);
    },
    final(callback) {
      callback(seenDone ? undefined : new UpstreamTransportError("STREAM_FAILURE"));
    },
  });
}

export function registerPiRoutes(
  app: FastifyInstance, pool: Pool, masterKey: Buffer, streams: ActiveStreams,
  deps: {
    resolveDestination?: typeof resolveAllowedDestination;
    postStream?: typeof postChatCompletionStream;
  } = {},
): void {
  const resolveDestination = deps.resolveDestination ?? resolveAllowedDestination;
  const postStream = deps.postStream ?? postChatCompletionStream;
  app.post("/v1/chat/completions", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      return reply.code(415).send(errorBody("INVALID_REQUEST"));
    }
    const rawToken = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
    const grant = rawToken ? await findAuthorizedTaskGrant(pool, rawToken) : null;
    if (!grant) return reply.code(401).send(errorBody("UNAUTHORIZED"));

    const controller = new AbortController();
    if (reply.raw.destroyed || request.raw.aborted) controller.abort();
    const unregister = streams.register(grant.taskId, grant.modelConnectionId, controller);
    if (!unregister) return reply.code(429).send(errorBody("TOO_MANY_STREAMS"));
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    try {
      const current = await findAuthorizedTaskGrant(pool, rawToken!);
      if (!current || current.id !== grant.id || controller.signal.aborted) {
        return reply.code(401).send(errorBody("UNAUTHORIZED"));
      }
      const connection = await getModelConnection(pool, grant.modelConnectionId);
      if (!connection?.enabled) return reply.code(409).send(errorBody("CONNECTION_UNAVAILABLE"));
      const requestedTools = Boolean(request.body && typeof request.body === "object" &&
        ("tools" in request.body || "tool_choice" in request.body));
      let sandbox = false;
      if (requestedTools) {
        try {
          const result = await pool.query<{ kind: string }>("SELECT kind FROM workspace_tasks WHERE id=$1", [grant.taskId]);
          sandbox = result.rows[0]?.kind === "sandbox";
        } catch (error) {
          if ((error as { code?: string }).code !== "42P01") throw error;
        }
      }
      const body = validatePiRequest(request.body, connection.modelId, sandbox);
      const origins = await listModelOrigins(pool);
      const destination = await resolveDestination(connection.baseUrl, origins.map((item) => item.origin));
      const credential = await readModelCredential(pool, masterKey, connection.id);
      if (!credential) return reply.code(409).send(errorBody("CONNECTION_UNAVAILABLE"));
      const latest = await findAuthorizedTaskGrant(pool, rawToken!);
      if (!latest || latest.id !== grant.id || controller.signal.aborted) {
        return reply.code(401).send(errorBody("UNAUTHORIZED"));
      }
      const upstream = await postStream(destination, body, {
        credential, signal: controller.signal, firstResponseTimeoutMs: 15_000, idleTimeoutMs: 30_000,
      });
      if (controller.signal.aborted) {
        upstream.destroy();
        return reply.code(401).send(errorBody("UNAUTHORIZED"));
      }
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      await pipeline(upstream, doneGuard(), reply.raw);
    } catch (error) {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
      } else if (error instanceof PiRequestError) {
        reply.code(error.code === "MODEL_MISMATCH" ? 403 : 400).send(errorBody(error.code));
      } else if (error instanceof UpstreamPolicyError) {
        reply.code(error.code === "DNS_UNAVAILABLE" ? 503 : 502).send(errorBody("TARGET_UNAVAILABLE"));
      } else if (error instanceof UpstreamTransportError) {
        reply.code(error.code.includes("TIMEOUT") ? 504 : 502).send(errorBody("UPSTREAM_FAILED"));
      } else {
        reply.code(500).send(errorBody("INTERNAL_ERROR"));
      }
    } finally {
      unregister();
    }
  });
}
