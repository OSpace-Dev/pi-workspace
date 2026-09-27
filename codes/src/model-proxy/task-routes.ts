import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ActiveStreams } from "./active-streams.ts";
import { abortTaskGrantRotation, finishTaskGrantRotation, rotateTaskGrant, TaskGrantError } from "./task-grant-store.ts";
import { createProxyTask, listProxyTaskGrantFingerprints, ProxyTaskError, resumeProxyTask, stopProxyTask } from "./proxy-task-store.ts";

export function registerTaskRoutes(app: FastifyInstance, pool: Pool, streams: ActiveStreams): void {
  app.post("/internal/tasks", async (request, reply) => {
    const body = request.body as { connectionId?: unknown } | undefined;
    if (typeof body?.connectionId !== "string") return reply.code(400).send({ error: { code: "INVALID_TASK" } });
    try {
      const created = await createProxyTask(pool, body.connectionId);
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof ProxyTaskError) {
        return reply.code(error.code === "CONNECTION_UNAVAILABLE" ? 409 : 400).send({ error: { code: error.code } });
      }
      throw error;
    }
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/stop", async (request, reply) => {
    try {
      const stopped = await stopProxyTask(pool, request.params.id);
      streams.abortTask(request.params.id);
      if (!stopped) return reply.code(404).send({ error: { code: "TASK_UNAVAILABLE" } });
      return { taskId: request.params.id, status: "stopped" };
    } catch (error) {
      if (error instanceof ProxyTaskError) return reply.code(400).send({ error: { code: error.code } });
      throw error;
    }
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/resume", async (request, reply) => {
    try {
      return { taskId: request.params.id, grant: await resumeProxyTask(pool, request.params.id) };
    } catch (error) {
      if (error instanceof ProxyTaskError) return reply.code(error.code === "INVALID_TASK" ? 400 : 409).send({ error: { code: error.code } });
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>("/internal/tasks/:id/grants", async (request, reply) => {
    try { return { items: await listProxyTaskGrantFingerprints(pool, request.params.id) }; }
    catch (error) {
      if (error instanceof ProxyTaskError) return reply.code(400).send({ error: { code: error.code } });
      throw error;
    }
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/rotate", async (request, reply) => {
    const body = request.body as { connectionId?: unknown; previousGrantId?: unknown } | undefined;
    if (typeof body?.connectionId !== "string" || typeof body.previousGrantId !== "string") {
      return reply.code(400).send({ error: { code: "INVALID_TASK" } });
    }
    try { return { grant: await rotateTaskGrant(pool, request.params.id, body.connectionId, body.previousGrantId) }; }
    catch (error) {
      if (error instanceof TaskGrantError) return reply.code(409).send({ error: { code: error.code } });
      throw error;
    }
  });
  for (const action of ["finish", "abort"] as const) {
    app.post<{ Params: { id: string } }>(`/internal/tasks/:id/rotation/${action}`, async (request, reply) => {
      const grantId = (request.body as { grantId?: unknown } | undefined)?.grantId;
      if (typeof grantId !== "string") return reply.code(400).send({ error: { code: "INVALID_TASK" } });
      try {
        if (action === "finish") await finishTaskGrantRotation(pool, request.params.id, grantId);
        else await abortTaskGrantRotation(pool, request.params.id, grantId);
        return { taskId: request.params.id, status: action === "finish" ? "completed" : "aborted" };
      } catch (error) {
        if (error instanceof TaskGrantError) return reply.code(409).send({ error: { code: error.code } });
        throw error;
      }
    });
  }
}
