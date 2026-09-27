import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { TaskRuntime } from "./task-runtime.ts";
import { assertTaskId } from "./task-files.ts";
import { SandboxRuntime } from "./sandbox-runtime.ts";
import type { AgentSandboxRuntime } from "./agent-sandbox-runtime.ts";
import { registerAgentSandboxRoutes } from "./agent-sandbox-routes.ts";

function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export function buildRuntimeAgent(runtime: TaskRuntime, serviceKey: string, sandbox?: SandboxRuntime, agents?: AgentSandboxRuntime) {
  if (serviceKey.length < 32) throw new Error("INVALID_SERVICE_KEY");
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const locks = new Map<string, Promise<unknown>>();
  async function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const preceding = locks.get(id);
    const work = (preceding ?? Promise.resolve()).catch(() => undefined).then(action);
    locks.set(id, work);
    try { return await work; }
    finally { if (locks.get(id) === work) locks.delete(id); }
  }
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!equalSecret(token, serviceKey)) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const invalid = ["INVALID_TASK_ID", "INVALID_TASK_CONFIG", "INVALID_TASK_TOKEN"].includes(message);
    const conflict = ["TASK_OWNER_MISMATCH", "CONTAINER_OWNER_MISMATCH", "TASK_SESSION_MISSING"].includes(message);
    return reply.code(invalid ? 400 : conflict ? 409 : 503)
      .send({ error: { code: invalid ? "INVALID_INPUT" : conflict ? message : "TASK_RUNTIME_ERROR" } });
  });
  app.get("/health", async () => ({ status: "ok", service: "runtime-agent" }));
  if (agents) registerAgentSandboxRoutes(app, agents);
  app.get<{ Params: { id: string } }>("/internal/tasks/:id", async (request) => {
    assertTaskId(request.params.id);
    return runtime.state(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/prepare", async (request) => {
    const { id } = request.params;
    assertTaskId(id);
    const body = request.body as { modelId?: unknown; token?: unknown } | undefined;
    if (typeof body?.modelId !== "string" || typeof body.token !== "string") throw new Error("INVALID_TASK_CONFIG");
    await serial(id, () => runtime.prepare(id, body.modelId as string, body.token as string));
    return { taskId: id, status: "running" };
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/token", async (request) => {
    const { id } = request.params;
    assertTaskId(id);
    const token = (request.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string") throw new Error("INVALID_TASK_TOKEN");
    await serial(id, () => runtime.replaceToken(id, token));
    return { taskId: id, status: "updated" };
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/resume", async (request) => {
    const { id } = request.params;
    assertTaskId(id);
    const token = (request.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string") throw new Error("INVALID_TASK_TOKEN");
    await serial(id, () => runtime.resume(id, token));
    return { taskId: id, status: "running" };
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/stop", async (request) => {
    const { id } = request.params;
    assertTaskId(id);
    await serial(id, () => runtime.stop(id));
    return { taskId: id, status: "stopped" };
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/delete", async (request) => {
    const { id } = request.params;
    assertTaskId(id);
    await serial(id, () => runtime.remove(id));
    return { taskId: id, status: "deleted" };
  });
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/prompt", async (request) => {
    const { id } = request.params;
    assertTaskId(id);
    const message = (request.body as { message?: unknown } | undefined)?.message;
    if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > 768 * 1024) {
      throw new Error("INVALID_TASK_CONFIG");
    }
    return runtime.prompt(id, message);
  });
  if (sandbox) {
    app.get<{ Params: { id: string } }>("/internal/sandboxes/:id", async (request) => {
      assertTaskId(request.params.id);
      return sandbox.state(request.params.id);
    });
    app.get<{ Params: { id: string } }>("/internal/sandboxes/:id/access", async (request) => {
      assertTaskId(request.params.id);
      return sandbox.access(request.params.id);
    });
    app.post<{ Params: { id: string } }>("/internal/sandboxes/:id/prepare", async (request) => {
      const { id } = request.params;
      assertTaskId(id);
      const body = request.body as { modelId?: unknown; token?: unknown } | undefined;
      if (typeof body?.modelId !== "string" || typeof body.token !== "string") throw new Error("INVALID_TASK_CONFIG");
      await serial(id, () => sandbox.prepare(id, body.modelId as string, body.token as string));
      return { taskId: id, status: "running" };
    });
    app.post<{ Params: { id: string } }>("/internal/sandboxes/:id/token", async (request) => {
      const { id } = request.params;
      assertTaskId(id);
      const token = (request.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string") throw new Error("INVALID_TASK_TOKEN");
      await serial(id, () => sandbox.replaceToken(id, token));
      return { taskId: id, status: "updated" };
    });
    app.post<{ Params: { id: string } }>("/internal/sandboxes/:id/resume", async (request) => {
      const { id } = request.params;
      assertTaskId(id);
      const token = (request.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string") throw new Error("INVALID_TASK_TOKEN");
      await serial(id, () => sandbox.resume(id, token));
      return { taskId: id, status: "running" };
    });
    app.post<{ Params: { id: string } }>("/internal/sandboxes/:id/stop", async (request) => {
      const { id } = request.params;
      assertTaskId(id);
      await serial(id, () => sandbox.stop(id));
      return { taskId: id, status: "stopped" };
    });
    app.post<{ Params: { id: string } }>("/internal/sandboxes/:id/delete", async (request) => {
      const { id } = request.params;
      assertTaskId(id);
      await serial(id, () => sandbox.remove(id));
      return { taskId: id, status: "deleted" };
    });
  }
  return app;
}
