import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  approveModelOrigin, createModelConnection, disableModelConnection,
  listModelConnections, listModelOrigins, replaceModelCredential,
} from "./connection-store.ts";
import { ActiveStreams } from "./active-streams.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_INPUT");
  return value as Record<string, unknown>;
}

function field(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) throw new Error("INVALID_INPUT");
  return value;
}

export function registerManagementRoutes(app: FastifyInstance, pool: Pool, masterKey: Buffer, streams: ActiveStreams): void {
  app.get("/internal/origins", async () => ({ items: await listModelOrigins(pool) }));
  app.post("/internal/origins", async (request, reply) => {
    const origin = await approveModelOrigin(pool, field(object(request.body), "origin", 512));
    return reply.code(201).send({ origin });
  });
  app.get("/internal/connections", async () => ({
    items: (await listModelConnections(pool)).map((item) => ({ ...item, credentialConfigured: true })),
  }));
  app.post("/internal/connections", async (request, reply) => {
    const body = object(request.body);
    const saved = await createModelConnection(pool, masterKey, {
      displayName: field(body, "displayName", 200), baseUrl: field(body, "baseUrl", 2048),
      modelId: field(body, "modelId", 200), credential: field(body, "credential", 8192),
    });
    return reply.code(201).send({ ...saved, credentialConfigured: true });
  });
  app.patch<{ Params: { id: string } }>("/internal/connections/:id/disable", async (request, reply) => {
    if (!uuid.test(request.params.id)) throw new Error("INVALID_INPUT");
    const saved = await disableModelConnection(pool, request.params.id, field(object(request.body), "version", 32));
    if (!saved) return reply.code(409).send({ error: { code: "STALE_OR_UNAVAILABLE" } });
    streams.abortConnection(saved.id);
    return { ...saved, credentialConfigured: true };
  });
  app.patch<{ Params: { id: string } }>("/internal/connections/:id/credential", async (request, reply) => {
    if (!uuid.test(request.params.id)) throw new Error("INVALID_INPUT");
    const body = object(request.body);
    const saved = await replaceModelCredential(pool, masterKey, request.params.id,
      field(body, "version", 32), field(body, "credential", 8192));
    if (!saved) return reply.code(409).send({ error: { code: "STALE_OR_UNAVAILABLE" } });
    streams.abortConnection(saved.id);
    return { ...saved, credentialConfigured: true };
  });
}
