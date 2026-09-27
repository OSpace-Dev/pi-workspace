import type { Pool } from "pg";
import { InternalClient, InternalServiceError } from "./task-clients.ts";
import {
  getTask, insertTask, listManagedTasks, listTasks, listTurns, removeTask,
  setTaskGrant, setTaskStatus, taskIdPattern, type WorkspaceTask,
} from "./task-store.ts";
import { DocumentStore } from "./document-store.ts";
import { documentPrompt, validateDocumentAnswer } from "./document-answer.ts";
import { DocumentError } from "./document-input.ts";

type Grant = { id: string; token: string; renewAt: string; expiresAt: string };
type Fingerprint = { id: string; digest: string; rotatedFrom: string | null; rotationCompleted: boolean; renewAt: string };

export class TaskServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

function requireTask(task: WorkspaceTask | null, kind: "qa" | "sandbox" = "qa"): WorkspaceTask {
  if (!task || task.kind !== kind) throw new TaskServiceError("TASK_NOT_FOUND", 404);
  return task;
}

export class TaskService {
  private readonly busy = new Set<string>();
  private readonly pool: Pool;
  private readonly proxy: InternalClient;
  private readonly runtime: InternalClient;
  constructor(pool: Pool, proxy: InternalClient, runtime: InternalClient) {
    this.pool = pool; this.proxy = proxy; this.runtime = runtime;
  }

  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new TaskServiceError("TASK_BUSY", 409);
    this.busy.add(id);
    try { return await action(); }
    finally { this.busy.delete(id); }
  }

  list() { return listTasks(this.pool); }
  listSandboxes() { return listTasks(this.pool, "sandbox"); }

  private route(task: WorkspaceTask): string { return task.kind === "sandbox" ? "sandboxes" : "tasks"; }

  async detail(id: string) {
    return { task: requireTask(await getTask(this.pool, id)), turns: await listTurns(this.pool, id) };
  }

  async sandboxDetail(id: string) {
    const task = requireTask(await getTask(this.pool, id), "sandbox");
    const state = await this.runtime.request<{ ready: boolean; running: boolean; webUrl: string | null }>(
      "GET", `/sandboxes/${id}`);
    return { task, ready: state.ready, running: state.running, webUrl: state.webUrl };
  }

  async sandboxAccess(id: string) {
    const task = requireTask(await getTask(this.pool, id), "sandbox");
    if (task.status !== "idle") throw new TaskServiceError("TASK_NOT_IDLE", 409);
    return this.runtime.request<{ url: string; password: string }>("GET", `/sandboxes/${id}/access`);
  }

  async create(connectionId: string, kind: "qa" | "sandbox" = "qa", displayName: string | null = null): Promise<WorkspaceTask> {
    if (!taskIdPattern.test(connectionId)) throw new TaskServiceError("INVALID_INPUT", 400);
    if (kind === "sandbox" && (typeof displayName !== "string" || !displayName.trim() ||
      displayName.trim().length > 80 || /[\u0000-\u001f]/.test(displayName))) {
      throw new TaskServiceError("INVALID_INPUT", 400);
    }
    const connections = await this.proxy.request<{ items: { id: string; modelId: string; enabled: boolean }[] }>("GET", "/connections");
    const connection = connections.items.find((item) => item.id === connectionId && item.enabled);
    if (!connection) throw new TaskServiceError("CONNECTION_UNAVAILABLE", 409);
    const created = await this.proxy.request<{ taskId: string; grant: Grant }>("POST", "/tasks", { connectionId });
    let inserted = false;
    this.busy.add(created.taskId);
    try {
      await insertTask(this.pool, created.taskId, connectionId, created.grant.id, new Date(created.grant.renewAt),
        kind, kind === "sandbox" ? displayName!.trim() : null);
      inserted = true;
      const route = kind === "sandbox" ? "sandboxes" : "tasks";
      await this.runtime.request("POST", `/${route}/${created.taskId}/prepare`, {
        modelId: connection.modelId, token: created.grant.token,
      }, kind === "sandbox" ? 45_000 : 35_000);
      await setTaskStatus(this.pool, created.taskId, ["starting"], "idle");
      return requireTask(await getTask(this.pool, created.taskId), kind);
    } catch {
      await this.proxy.request("POST", `/tasks/${created.taskId}/stop`).catch(() => undefined);
      await this.runtime.request("POST", `/${kind === "sandbox" ? "sandboxes" : "tasks"}/${created.taskId}/stop`).catch(() => undefined);
      if (inserted) await setTaskStatus(this.pool, created.taskId, ["starting"], "failed", "TASK_START_FAILED");
      throw new TaskServiceError("TASK_START_FAILED", 503);
    } finally { this.busy.delete(created.taskId); }
  }

  async prompt(id: string, message: string) {
    if (!taskIdPattern.test(id) || typeof message !== "string" || !message.trim() ||
        Buffer.byteLength(message, "utf8") > 32 * 1024) throw new TaskServiceError("INVALID_INPUT", 400);
    if (this.busy.has(id)) throw new TaskServiceError("TASK_BUSY", 409);
    requireTask(await getTask(this.pool, id));
    const documents = new DocumentStore(this.pool);
    const { turnId, sources } = await documents.beginQuestion(id, message);
    try {
      const prompt = sources.length ? documentPrompt(message, sources) : message;
      await documents.phase(turnId, "model");
      const response = await this.runtime.request<{ answer: string }>("POST", `/tasks/${id}/prompt`, { message: prompt }, 130_000);
      await documents.phase(turnId, "validating");
      const result = sources.length ? validateDocumentAnswer(response.answer, sources) : null;
      const answer = result ? result.claims.map((claim) => claim.text).join("\n\n") : response.answer;
      if (!await documents.settle(id, turnId, answer, result, null)) throw new TaskServiceError("ANSWER_INTERRUPTED", 502);
      return { turnId, answer, result };
    } catch (error) {
      const code = error instanceof DocumentError || error instanceof TaskServiceError ? error.code : "ANSWER_FAILED";
      await documents.settle(id, turnId, null, null, code);
      throw error instanceof DocumentError ? error : new TaskServiceError(code, 502);
    }
  }

  async stop(id: string, kind: "qa" | "sandbox" = "qa"): Promise<WorkspaceTask> {
    return this.exclusive(id, async () => {
      const task = requireTask(await getTask(this.pool, id), kind);
      if (task.status === "stopped") return task;
      if (!["idle", "answering", "failed", "starting", "resuming", "stopping"].includes(task.status)) {
        throw new TaskServiceError("TASK_BUSY", 409);
      }
      if (!await setTaskStatus(this.pool, id,
        ["idle", "answering", "failed", "starting", "resuming", "stopping"], "stopping")) {
        throw new TaskServiceError("TASK_BUSY", 409);
      }
      try {
        await this.pool.query(`UPDATE workspace_turns SET status='failed',phase='failed',answer=NULL,result=NULL,
          error_code='ANSWER_INTERRUPTED',completed_at=clock_timestamp() WHERE task_id=$1 AND status='pending'`, [id]);
        await this.stopProxy(id);
        await this.runtime.request("POST", `/${this.route(task)}/${id}/stop`);
        await setTaskStatus(this.pool, id, ["stopping"], "stopped", null, null);
      } catch {
        await setTaskStatus(this.pool, id, ["stopping"], "stopping", "TASK_STOP_FAILED");
        throw new TaskServiceError("TASK_STOP_FAILED", 503);
      }
      return requireTask(await getTask(this.pool, id), kind);
    });
  }

  async resume(id: string, kind: "qa" | "sandbox" = "qa"): Promise<WorkspaceTask> {
    return this.exclusive(id, async () => {
      const task = requireTask(await getTask(this.pool, id), kind);
      if (task.status !== "stopped") throw new TaskServiceError("TASK_NOT_STOPPED", 409);
      const state = await this.runtime.request<{ exists: boolean; running: boolean; session: boolean }>("GET", `/${this.route(task)}/${id}`);
      if (!state.exists || !state.session || state.running) throw new TaskServiceError("TASK_SESSION_MISSING", 409);
      await setTaskStatus(this.pool, id, ["stopped"], "resuming");
      try {
        const result = await this.proxy.request<{ grant: Grant }>("POST", `/tasks/${id}/resume`);
        await this.runtime.request("POST", `/${this.route(task)}/${id}/resume`, { token: result.grant.token }, 45_000);
        await setTaskStatus(this.pool, id, ["resuming"], "idle", null,
          { id: result.grant.id, renewAt: new Date(result.grant.renewAt) });
        return requireTask(await getTask(this.pool, id), kind);
      } catch {
        await this.stopProxy(id).catch(() => undefined);
        await this.runtime.request("POST", `/${this.route(task)}/${id}/stop`).catch(() => undefined);
        await setTaskStatus(this.pool, id, ["resuming"], "failed", "TASK_RESUME_FAILED", null);
        throw new TaskServiceError("TASK_RESUME_FAILED", 503);
      }
    });
  }

  async delete(id: string, kind: "qa" | "sandbox" = "qa"): Promise<void> {
    return this.exclusive(id, async () => {
      const task = requireTask(await getTask(this.pool, id), kind);
      if (task.status !== "deleting" && !await setTaskStatus(this.pool, id,
        ["idle", "answering", "failed", "starting", "resuming", "stopping", "stopped"], "deleting")) {
        throw new TaskServiceError("TASK_BUSY", 409);
      }
      try {
        await this.stopProxy(id);
        await this.runtime.request("POST", `/${this.route(task)}/${id}/delete`, undefined, 30_000);
        await removeTask(this.pool, id);
      } catch {
        await setTaskStatus(this.pool, id, ["deleting"], "deleting", "TASK_DELETE_FAILED");
        throw new TaskServiceError("TASK_DELETE_FAILED", 503);
      }
    });
  }

  private async stopProxy(id: string): Promise<void> {
    try { await this.proxy.request("POST", `/tasks/${id}/stop`); }
    catch (error) {
      if (!(error instanceof InternalServiceError && error.status === 404)) throw error;
    }
  }

  async reconcileAndRenew(): Promise<void> {
    for (const task of await listManagedTasks(this.pool)) {
      if (this.busy.has(task.id) || task.status === "answering") continue;
      const runtimePath = `/${this.route(task)}/${task.id}`;
      try {
        if (task.status === "stopping") { await this.stop(task.id, task.kind); continue; }
        if (task.status === "deleting") { await this.delete(task.id, task.kind); continue; }
        if (task.status === "failed") {
          await this.stopProxy(task.id);
          await this.runtime.request("POST", `${runtimePath}/stop`);
          continue;
        }
        if (task.status === "starting" || task.status === "resuming") {
          await this.stopProxy(task.id);
          await this.runtime.request("POST", `${runtimePath}/stop`).catch(() => undefined);
          await setTaskStatus(this.pool, task.id, [task.status], "failed", "INTERRUPTED_START");
          continue;
        }
        if (task.status !== "idle") continue;
        await this.exclusive(task.id, async () => {
          const state = await this.runtime.request<{
            exists: boolean; running: boolean; ready: boolean; fingerprint: string | null;
          }>("GET", runtimePath);
          if (!state.exists || !state.running || !state.ready || !state.fingerprint) {
            await this.stopProxy(task.id);
            await this.runtime.request("POST", `${runtimePath}/stop`);
            await setTaskStatus(this.pool, task.id, ["idle"], "failed", "TASK_CONTAINER_STOPPED");
            return;
          }
          const grants = await this.proxy.request<{ items: Fingerprint[] }>("GET", `/tasks/${task.id}/grants`);
          const pending = grants.items.find((item) => item.rotatedFrom && !item.rotationCompleted);
          if (pending) {
            if (state.fingerprint === pending.digest) {
              await this.proxy.request("POST", `/tasks/${task.id}/rotation/finish`, { grantId: pending.id });
              await setTaskGrant(this.pool, task.id, pending.id, new Date(pending.renewAt));
            } else if (grants.items.some((item) => item.id === pending.rotatedFrom && item.digest === state.fingerprint)) {
              await this.proxy.request("POST", `/tasks/${task.id}/rotation/abort`, { grantId: pending.id });
            } else {
              await this.stopProxy(task.id);
              await this.runtime.request("POST", `${runtimePath}/stop`);
              await setTaskStatus(this.pool, task.id, ["idle"], "failed", "TASK_TOKEN_UNAVAILABLE");
            }
            return;
          }
          const current = grants.items.find((item) => item.digest === state.fingerprint);
          if (!current) {
            await this.stopProxy(task.id);
            await this.runtime.request("POST", `${runtimePath}/stop`);
            await setTaskStatus(this.pool, task.id, ["idle"], "failed", "TASK_TOKEN_UNAVAILABLE");
            return;
          }
          if (current.id !== task.currentGrantId) await setTaskGrant(this.pool, task.id, current.id, new Date(current.renewAt));
          if (new Date(current.renewAt).getTime() > Date.now()) return;
          const rotated = await this.proxy.request<{ grant: Grant }>("POST", `/tasks/${task.id}/rotate`, {
            connectionId: task.modelConnectionId, previousGrantId: current.id,
          });
          let fileUpdated = false;
          try {
            await this.runtime.request("POST", `${runtimePath}/token`, { token: rotated.grant.token });
            fileUpdated = true;
            await this.proxy.request("POST", `/tasks/${task.id}/rotation/finish`, { grantId: rotated.grant.id });
            await setTaskGrant(this.pool, task.id, rotated.grant.id, new Date(rotated.grant.renewAt));
          } catch (error) {
            if (!fileUpdated) {
              const latest = await this.runtime.request<{ fingerprint: string | null }>("GET", runtimePath)
                .catch(() => null);
              const grantsAfterWrite = await this.proxy.request<{ items: Fingerprint[] }>("GET", `/tasks/${task.id}/grants`)
                .catch(() => null);
              const newDigest = grantsAfterWrite?.items.find((item) => item.id === rotated.grant.id)?.digest;
              if (latest && newDigest && latest.fingerprint !== newDigest) {
                await this.proxy.request("POST", `/tasks/${task.id}/rotation/abort`, { grantId: rotated.grant.id });
              }
            }
            throw error;
          }
        });
      } catch {
        if (task.status === "idle") {
          await setTaskStatus(this.pool, task.id, ["idle"], "idle", "TOKEN_RENEWAL_RETRY").catch(() => undefined);
        }
      }
    }
  }

  async recoverInterruptedAnswers(): Promise<void> {
    for (const task of await listManagedTasks(this.pool)) {
      if (task.status !== "answering") continue;
      await this.stopProxy(task.id).catch(() => undefined);
      await this.runtime.request("POST", `/tasks/${task.id}/stop`).catch(() => undefined);
      await this.pool.query(`UPDATE workspace_turns SET status = 'failed', phase = 'failed', answer=NULL,result=NULL,error_code = 'INTERRUPTED_ANSWER',
        completed_at = clock_timestamp() WHERE task_id = $1 AND status = 'pending'`, [task.id]);
      await setTaskStatus(this.pool, task.id, ["answering"], "failed", "INTERRUPTED_ANSWER", null);
    }
  }
}
