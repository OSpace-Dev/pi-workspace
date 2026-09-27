import type { FastifyInstance } from "fastify";
import { TaskService, TaskServiceError } from "./task-service.ts";
import type { AgentSandboxService } from "./agent-sandbox-service.ts";

export function registerSandboxRoutes(app: FastifyInstance, tasks: TaskService, agents?: AgentSandboxService): void {
  const service = agents ?? tasks;
  app.get("/api/v1/sandboxes", async () => ({ items: await service.listSandboxes() }));
  app.post("/api/v1/sandboxes", async (request, reply) => {
    const body = request.body as { name?: unknown; connectionId?: unknown } | undefined;
    if (typeof body?.name !== "string" || (!agents && typeof body.connectionId !== "string") ||
      (agents && Object.keys(body).some((key) => key !== "name"))) {
      throw new TaskServiceError("INVALID_INPUT", 400);
    }
    return reply.code(201).send({ task: agents ? await agents.create(body.name) :
      await tasks.create(body.connectionId as string, "sandbox", body.name) });
  });
  app.get<{ Params: { id: string } }>("/api/v1/sandboxes/:id", async (request) =>
    service.sandboxDetail(request.params.id));
  app.get<{ Params: { id: string } }>("/api/v1/sandboxes/:id/access", async (request) =>
    service.sandboxAccess(request.params.id));
  app.post<{ Params: { id: string } }>("/api/v1/sandboxes/:id/stop", async (request) => ({
    task: agents ? await agents.stop(request.params.id) : await tasks.stop(request.params.id, "sandbox"),
  }));
  app.post<{ Params: { id: string } }>("/api/v1/sandboxes/:id/resume", async (request) => ({
    task: agents ? await agents.resume(request.params.id) : await tasks.resume(request.params.id, "sandbox"),
  }));
  app.delete<{ Params: { id: string } }>("/api/v1/sandboxes/:id", async (request, reply) => {
    if (agents) await agents.delete(request.params.id);
    else await tasks.delete(request.params.id, "sandbox");
    return reply.code(204).send();
  });
}
