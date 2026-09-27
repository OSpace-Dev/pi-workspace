import type { FastifyInstance } from "fastify";
import type { AgentSandboxRuntime } from "./agent-sandbox-runtime.ts";
import { assertTaskId } from "./task-files.ts";

export function registerAgentSandboxRoutes(app: FastifyInstance, runtime: AgentSandboxRuntime): void {
  const locks = new Map<string, Promise<unknown>>();
  async function serial(id: string, action: () => Promise<void>) {
    const work = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    locks.set(id, work);
    try { await work; } finally { if (locks.get(id) === work) locks.delete(id); }
  }
  app.get<{ Params: { id: string } }>("/internal/agents/:id", async (request) => {
    assertTaskId(request.params.id); return runtime.state(request.params.id);
  });
  app.get<{ Params: { id: string } }>("/internal/agents/:id/access", async (request) => {
    assertTaskId(request.params.id); return runtime.access(request.params.id);
  });
  for (const operation of ["prepare", "resume", "stop", "delete"] as const) {
    app.post<{ Params: { id: string } }>(`/internal/agents/:id/${operation}`, async (request) => {
      const { id } = request.params;
      assertTaskId(id);
      await serial(id, () => operation === "delete" ? runtime.remove(id) : runtime[operation](id));
      return { taskId: id, operation };
    });
  }
}
