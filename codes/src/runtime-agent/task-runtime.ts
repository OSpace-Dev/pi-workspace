import { readFile } from "node:fs/promises";
import path from "node:path";
import { DockerEngine, type Container, DockerError } from "./docker-engine.ts";
import { assertTaskId, TaskFiles } from "./task-files.ts";

export class TaskRuntime {
  private readonly docker: DockerEngine;
  private readonly files: TaskFiles;
  private readonly image: string;
  private readonly network: string;
  constructor(docker: DockerEngine, files: TaskFiles, image: string, network: string) {
    this.docker = docker; this.files = files; this.image = image; this.network = network;
  }

  private name(taskId: string): string { assertTaskId(taskId); return `piws-task-${taskId}`; }

  private async owned(taskId: string): Promise<Container | null> {
    const container = await this.docker.inspect(this.name(taskId));
    if (!container) return null;
    if ((await this.files.readOwner(taskId)).kind !== "qa") throw new Error("TASK_OWNER_MISMATCH");
    const root = this.files.hostDir(taskId);
    const mounts = new Map(container.Mounts.map((mount) => [mount.Destination, mount.Source]));
    if (container.Config.Image !== this.image || container.Config.Labels?.["piws.task.id"] !== taskId ||
        container.Config.Labels?.["piws.runtime"] !== "local-v1" ||
        mounts.get("/workspace") !== path.posix.join(root, "workspace") ||
        mounts.get("/data/pi-agent") !== path.posix.join(root, "agent") ||
        mounts.get("/run/piws-token") !== path.posix.join(root, "token")) {
      throw new Error("CONTAINER_OWNER_MISMATCH");
    }
    return container;
  }

  async prepare(taskId: string, modelId: string, token: string): Promise<void> {
    const workerKey = await this.files.prepare(taskId, modelId, token);
    let container = await this.owned(taskId);
    if (!container) {
      const root = this.files.hostDir(taskId);
      await this.docker.create(this.name(taskId), {
        Image: this.image, User: "10001:10001", WorkingDir: "/workspace",
        Env: [`PIWS_WORKER_KEY=${workerKey}`, `PIWS_MODEL_ID=${modelId}`, "PI_CODING_AGENT_DIR=/data/pi-agent"],
        Labels: { "piws.task.id": taskId, "piws.runtime": "local-v1" },
        HostConfig: {
          NetworkMode: this.network,
          Binds: [
            `${root}/workspace:/workspace:rw`, `${root}/agent:/data/pi-agent:rw`,
            `${root}/token:/run/piws-token:ro`,
          ],
          ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128,
          Tmpfs: { "/tmp": "rw,nosuid,noexec,size=67108864" },
          Init: true,
        },
      });
      container = await this.owned(taskId);
    }
    if (!container) throw new Error("CONTAINER_CREATE_FAILED");
    if (!container.State.Running) await this.docker.start(this.name(taskId));
    await this.waitReady(taskId);
  }

  async state(taskId: string): Promise<{
    exists: boolean; running: boolean; ready: boolean; session: boolean; fingerprint: string | null;
  }> {
    const container = await this.owned(taskId);
    if (!container) return { exists: false, running: false, ready: false, session: false, fingerprint: null };
    const ready = container.State.Running && await this.worker(taskId, "/health")
      .then((response) => response.ok).catch(() => false);
    return {
      exists: true, running: container.State.Running, ready,
      session: await this.files.hasSession(taskId), fingerprint: await this.files.fingerprint(taskId),
    };
  }

  async replaceToken(taskId: string, token: string): Promise<void> {
    if (!await this.owned(taskId)) throw new Error("TASK_CONTAINER_MISSING");
    await this.files.writeToken(taskId, token);
  }

  async resume(taskId: string, token: string): Promise<void> {
    const container = await this.owned(taskId);
    if (!container || !await this.files.hasSession(taskId)) throw new Error("TASK_SESSION_MISSING");
    await this.files.writeToken(taskId, token);
    if (!container.State.Running) await this.docker.start(this.name(taskId));
    await this.waitReady(taskId);
  }

  async stop(taskId: string): Promise<void> {
    const container = await this.owned(taskId);
    if (!container?.State.Running) return;
    try { await this.docker.stop(this.name(taskId)); }
    catch (error) { if (!(error instanceof DockerError && error.status === 304)) throw error; }
  }

  async remove(taskId: string): Promise<void> {
    await this.stop(taskId);
    if (await this.owned(taskId)) await this.docker.remove(this.name(taskId));
    await this.files.remove(taskId);
  }

  async prompt(taskId: string, message: string): Promise<{ answer: string }> {
    const response = await this.worker(taskId, "/prompt", { message }, 125_000);
    if (!response.ok) throw new Error(`PI_${response.status}`);
    const body = await response.json() as { answer?: unknown };
    if (typeof body.answer !== "string") throw new Error("INVALID_PI_RESULT");
    return { answer: body.answer };
  }

  private async worker(taskId: string, route: string, body?: unknown, timeout = 4000): Promise<Response> {
    const container = await this.owned(taskId);
    if (!container?.State.Running) throw new Error("TASK_NOT_RUNNING");
    const address = container.NetworkSettings.Networks[this.network]?.IPAddress;
    if (!address) throw new Error("TASK_NETWORK_MISSING");
    const key = await readFile(path.join(this.files.base, taskId, "worker-key"), "utf8");
    return fetch(`http://${address}:4101${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  }

  private async waitReady(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt++) {
      try { if ((await this.worker(taskId, "/health")).ok) return; }
      catch { /* container may still be starting */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("PI_START_TIMEOUT");
  }
}
