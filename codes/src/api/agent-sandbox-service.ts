import { randomUUID } from "node:crypto";
import { AgentSandboxStore, type AgentSandbox } from "./agent-sandbox-store.ts";
import { InternalClient } from "./task-clients.ts";
import { TaskService, TaskServiceError } from "./task-service.ts";

export type SandboxProbe = {
  exists: boolean; running: boolean; ready: boolean; webUrl: string | null;
  containerState: string; observedAt: string; errorCode: string | null;
};
export class AgentSandboxService {
  private readonly store: AgentSandboxStore;
  private readonly runtime: InternalClient;
  private readonly legacy: TaskService;
  private readonly busy = new Set<string>();
  constructor(store: AgentSandboxStore, runtime: InternalClient, legacy: TaskService) {
    this.store = store; this.runtime = runtime; this.legacy = legacy;
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new TaskServiceError("TASK_BUSY", 409);
    this.busy.add(id);
    try { return await action(); } finally { this.busy.delete(id); }
  }
  private async require(id: string): Promise<AgentSandbox> {
    const item = await this.store.get(id);
    if (!item) throw new TaskServiceError("TASK_NOT_FOUND", 404);
    return item;
  }
  private path(id: string) { return `/agents/${id}`; }
  async listSandboxes() {
    const [items, old] = await Promise.all([this.store.list(), this.legacy.listSandboxes()]);
    return [...items, ...old.map((item) => ({ ...item, mode: "legacy" as const }))];
  }
  async sandboxDetail(id: string) {
    const item = await this.store.get(id);
    if (!item) {
      const result = await this.legacy.sandboxDetail(id);
      return { ...result, task: { ...result.task, mode: "legacy" } };
    }
    const probe = await this.runtime.request<SandboxProbe>("GET", this.path(id)).catch(() => ({
      exists: false, running: false, ready: false, webUrl: null,
      containerState: "unknown", observedAt: new Date().toISOString(), errorCode: "TASK_RUNTIME_ERROR",
    }));
    return { task: item, ...probe };
  }
  async sandboxAccess(id: string) {
    if (!await this.store.get(id)) return this.legacy.sandboxAccess(id);
    const item = await this.require(id);
    if (item.status !== "idle") throw new TaskServiceError("TASK_NOT_IDLE", 409);
    return this.runtime.request<{ url: string; password: string }>("GET", `${this.path(id)}/access`);
  }
  async create(name: string): Promise<AgentSandbox> {
    if (!name.trim() || name.trim().length > 80 || /[\u0000-\u001f]/.test(name)) {
      throw new TaskServiceError("INVALID_INPUT", 400);
    }
    const id = randomUUID();
    return this.exclusive(id, async () => {
      await this.store.insert(id, name.trim());
      try {
        await this.runtime.request("POST", `${this.path(id)}/prepare`, {}, 45_000);
        await this.store.transition(id, ["starting"], "idle");
      } catch {
        await this.runtime.request("POST", `${this.path(id)}/stop`).catch(() => undefined);
        await this.store.transition(id, ["starting"], "failed", "TASK_START_FAILED");
        throw new TaskServiceError("TASK_START_FAILED", 503);
      }
      return this.require(id);
    });
  }
  async stop(id: string) {
    if (!await this.store.get(id)) return this.legacy.stop(id, "sandbox");
    return this.exclusive(id, async () => {
      const item = await this.require(id);
      if (item.status === "stopped") return item;
      if (!await this.store.transition(id, ["idle", "failed", "starting", "resuming", "stopping"], "stopping")) {
        throw new TaskServiceError("TASK_BUSY", 409);
      }
      try {
        await this.runtime.request("POST", `${this.path(id)}/stop`);
        await this.store.transition(id, ["stopping"], "stopped");
      } catch {
        await this.store.transition(id, ["stopping"], "stopping", "TASK_STOP_FAILED");
        throw new TaskServiceError("TASK_STOP_FAILED", 503);
      }
      return this.require(id);
    });
  }
  async resume(id: string) {
    if (!await this.store.get(id)) return this.legacy.resume(id, "sandbox");
    return this.exclusive(id, async () => {
      if (!await this.store.transition(id, ["stopped"], "resuming")) throw new TaskServiceError("TASK_NOT_STOPPED", 409);
      try {
        await this.runtime.request("POST", `${this.path(id)}/resume`, {}, 45_000);
        await this.store.transition(id, ["resuming"], "idle");
      } catch {
        await this.runtime.request("POST", `${this.path(id)}/stop`).catch(() => undefined);
        await this.store.transition(id, ["resuming"], "failed", "TASK_RESUME_FAILED");
        throw new TaskServiceError("TASK_RESUME_FAILED", 503);
      }
      return this.require(id);
    });
  }
  async delete(id: string): Promise<void> {
    if (!await this.store.get(id)) return this.legacy.delete(id, "sandbox");
    await this.exclusive(id, async () => {
      if (!await this.store.transition(id, ["idle", "failed", "starting", "resuming", "stopping", "stopped", "deleting"], "deleting")) {
        throw new TaskServiceError("TASK_BUSY", 409);
      }
      try {
        await this.runtime.request("POST", `${this.path(id)}/delete`, {}, 30_000);
        await this.store.remove(id);
      } catch {
        await this.store.transition(id, ["deleting"], "deleting", "TASK_DELETE_FAILED");
        throw new TaskServiceError("TASK_DELETE_FAILED", 503);
      }
    });
  }
  async reconcile(): Promise<void> {
    for (const item of await this.store.managed()) {
      if (this.busy.has(item.id)) continue;
      try {
        if (item.status === "stopping") { await this.stop(item.id); continue; }
        if (item.status === "deleting") { await this.delete(item.id); continue; }
        await this.exclusive(item.id, async () => {
          if (["starting", "resuming", "failed"].includes(item.status)) {
            await this.runtime.request("POST", `${this.path(item.id)}/stop`);
            if (item.status !== "failed") await this.store.transition(item.id, [item.status], "failed", "INTERRUPTED_START");
            return;
          }
          const probe = await this.runtime.request<SandboxProbe>("GET", this.path(item.id));
          if (!probe.running) {
            await this.runtime.request("POST", `${this.path(item.id)}/stop`);
            await this.store.transition(item.id, ["idle"], "failed", "TASK_CONTAINER_STOPPED");
          }
        });
      } catch { console.warn("SANDBOX_RECONCILIATION_RETRY"); }
    }
  }
}
