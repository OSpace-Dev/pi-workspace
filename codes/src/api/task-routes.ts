import type { FastifyInstance } from "fastify";
import { TaskService, TaskServiceError } from "./task-service.ts";

export function registerTaskRoutes(app: FastifyInstance, tasks: TaskService): void {
  app.get("/api/v1/tasks", async () => ({ items: await tasks.list() }));
  app.post("/api/v1/tasks", async (request, reply) => {
    const connectionId = (request.body as { connectionId?: unknown } | undefined)?.connectionId;
    if (typeof connectionId !== "string") throw new TaskServiceError("INVALID_INPUT", 400);
    return reply.code(201).send({ task: await tasks.create(connectionId) });
  });
  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request) => tasks.detail(request.params.id));
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/prompt", async (request) => {
    const message = (request.body as { message?: unknown } | undefined)?.message;
    if (typeof message !== "string") throw new TaskServiceError("INVALID_INPUT", 400);
    return tasks.prompt(request.params.id, message);
  });
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/stop", async (request) => ({
    task: await tasks.stop(request.params.id),
  }));
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/resume", async (request) => ({
    task: await tasks.resume(request.params.id),
  }));
  app.delete<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request, reply) => {
    await tasks.delete(request.params.id);
    return reply.code(204).send();
  });
}
