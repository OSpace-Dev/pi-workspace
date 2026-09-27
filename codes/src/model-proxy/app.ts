import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { ActiveStreams } from "./active-streams.ts";
import { CredentialVaultError } from "./credential-vault.ts";
import { registerManagementRoutes } from "./management-routes.ts";
import { registerPiRoutes } from "./pi-routes.ts";
import { registerTaskRoutes } from "./task-routes.ts";
import { UpstreamPolicyError } from "./upstream-policy.ts";

export function buildModelProxy(options: {
  pool: Pool; masterKey: Buffer; serviceKey: string;
  pi?: Parameters<typeof registerPiRoutes>[4];
}) {
  if (options.serviceKey.length < 32) throw new Error("Invalid service key");
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 });
  const streams = new ActiveStreams();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const left = Buffer.from(bearer ?? "");
    const right = Buffer.from(options.serviceKey);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UpstreamPolicyError) {
      return reply.code(error.code === "DNS_UNAVAILABLE" ? 503 : 422).send({ error: { code: error.code } });
    }
    if (error instanceof CredentialVaultError || (error instanceof Error &&
        ["INVALID_INPUT", "INVALID_CONNECTION_METADATA"].includes(error.message))) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT" } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500)
      .send({ error: { code: status && status < 500 ? "INVALID_INPUT" : "INTERNAL_ERROR" } });
  });
  registerManagementRoutes(app, options.pool, options.masterKey, streams);
  registerTaskRoutes(app, options.pool, streams);
  registerPiRoutes(app, options.pool, options.masterKey, streams, options.pi);
  app.get("/health", async () => ({ status: "ok", service: "model-proxy" }));
  app.addHook("onClose", async () => { streams.abortAll(); });
  return app;
}
