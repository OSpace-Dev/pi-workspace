import path from "node:path";
import { DockerEngine, DockerError, type Container } from "./docker-engine.ts";
import { assertTaskId, TaskFiles } from "./task-files.ts";

export class SandboxRuntime {
  private readonly docker: DockerEngine;
  private readonly files: TaskFiles;
  private readonly image: string;
  private readonly gatewayImage: string;
  private readonly taskNetwork: string;
  private readonly managementNetwork: string;
  constructor(docker: DockerEngine, files: TaskFiles, image: string, gatewayImage: string,
    taskNetwork: string, managementNetwork: string) {
    this.docker = docker; this.files = files; this.image = image; this.gatewayImage = gatewayImage;
    this.taskNetwork = taskNetwork; this.managementNetwork = managementNetwork;
  }

  private webName(id: string) { assertTaskId(id); return `piws-sandbox-${id}`; }
  private gatewayName(id: string) { assertTaskId(id); return `piws-sandbox-gateway-${id}`; }

  private async owned(id: string, gateway = false): Promise<Container | null> {
    const container = await this.docker.inspect(gateway ? this.gatewayName(id) : this.webName(id));
    if (!container) return null;
    if ((await this.files.readOwner(id)).kind !== "sandbox") throw new Error("TASK_OWNER_MISMATCH");
    const labels = container.Config.Labels ?? {};
    const expectedImage = gateway ? this.gatewayImage : this.image;
    const networks = container.NetworkSettings.Networks;
    const config = container.HostConfig;
    if (container.Config.Image !== expectedImage || labels["piws.task.id"] !== id ||
      labels["piws.runtime"] !== "sandbox-v1" || labels["piws.role"] !== (gateway ? "gateway" : "web") ||
      container.Config.User !== "10001:10001" || config.Privileged || !config.ReadonlyRootfs ||
      !config.CapDrop?.includes("ALL") || !config.SecurityOpt?.includes("no-new-privileges:true") ||
      (gateway ? !networks[this.managementNetwork] : !networks[this.taskNetwork] || Boolean(networks[this.managementNetwork]))) {
      throw new Error("CONTAINER_OWNER_MISMATCH");
    }
    if (!gateway) {
      const root = this.files.hostDir(id);
      const mounts = new Map(container.Mounts.map((mount) => [mount.Destination, mount]));
      if (mounts.size !== 3 || mounts.get("/workspace")?.Source !== path.posix.join(root, "workspace") ||
        mounts.get("/workspace")?.RW !== true ||
        mounts.get("/data/pi-agent")?.Source !== path.posix.join(root, "agent") ||
        mounts.get("/data/pi-agent")?.RW !== true ||
        mounts.get("/run/piws-token")?.Source !== path.posix.join(root, "token") ||
        mounts.get("/run/piws-token")?.RW !== false ||
        Object.keys(config.PortBindings ?? {}).length) throw new Error("CONTAINER_OWNER_MISMATCH");
    } else if (container.Mounts.length || Object.keys(config.PortBindings ?? {}).join() !== "8080/tcp" ||
      config.PortBindings?.["8080/tcp"]?.[0]?.HostIp !== "127.0.0.1") {
      throw new Error("CONTAINER_OWNER_MISMATCH");
    }
    return container;
  }

  async prepare(id: string, modelId: string, token: string): Promise<void> {
    await this.files.prepare(id, modelId, token, "sandbox");
    const password = await this.files.webPassword(id, true);
    if (!await this.owned(id)) {
      const root = this.files.hostDir(id);
      await this.docker.create(this.webName(id), {
        Image: this.image, User: "10001:10001", WorkingDir: "/workspace",
        Cmd: ["pi-web", "--hostname", "0.0.0.0", "--port", "30141", "--no-open"],
        Env: ["PI_CODING_AGENT_DIR=/data/pi-agent", `PI_WEB_PASSWORD=${password}`,
          "PI_WEB_SKIP_VERSION_CHECK=1", `PI_WEB_ALLOWED_HOSTS=${this.webName(id)}`],
        Labels: { "piws.task.id": id, "piws.runtime": "sandbox-v1", "piws.role": "web" },
        HostConfig: { NetworkMode: this.taskNetwork,
          Binds: [`${root}/workspace:/workspace:rw`, `${root}/agent:/data/pi-agent:rw`, `${root}/token:/run/piws-token:ro`],
          ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          Memory: 768 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128,
          Tmpfs: { "/tmp": "rw,nosuid,noexec,size=67108864" }, Init: true },
      });
    }
    if (!await this.owned(id, true)) {
      await this.docker.create(this.gatewayName(id), {
        Image: this.gatewayImage, User: "10001:10001",
        Env: [`SANDBOX_HOST=${this.webName(id)}`],
        ExposedPorts: { "8080/tcp": {} },
        Labels: { "piws.task.id": id, "piws.runtime": "sandbox-v1", "piws.role": "gateway" },
        HostConfig: { NetworkMode: this.managementNetwork,
          PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
          ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          Memory: 128 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 64, Init: true },
      });
    }
    if (!(await this.owned(id, true))?.NetworkSettings.Networks[this.taskNetwork]) {
      await this.docker.connect(this.taskNetwork, this.gatewayName(id));
    }
    await this.start(id);
  }

  private async start(id: string): Promise<void> {
    for (const gateway of [false, true]) {
      const container = await this.owned(id, gateway);
      if (!container) throw new Error("TASK_CONTAINER_MISSING");
      if (!container.State.Running) await this.docker.start(gateway ? this.gatewayName(id) : this.webName(id));
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const state = await this.state(id);
      if (state.ready) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("PI_START_TIMEOUT");
  }

  async state(id: string): Promise<{ exists: boolean; running: boolean; ready: boolean; session: boolean;
    fingerprint: string | null; webUrl: string | null }> {
    const web = await this.owned(id);
    const gateway = await this.owned(id, true);
    if (!web || !gateway) return { exists: Boolean(web || gateway), running: false, ready: false,
      session: false, fingerprint: null, webUrl: null };
    const binding = gateway.NetworkSettings.Ports?.["8080/tcp"]?.find((port) => port.HostIp === "127.0.0.1");
    const webUrl = binding && /^\d+$/.test(binding.HostPort) ? `http://127.0.0.1:${binding.HostPort}` : null;
    const running = web.State.Running && gateway.State.Running;
    let ready = false;
    if (running && webUrl) {
      const ip = gateway.NetworkSettings.Networks[this.taskNetwork]?.IPAddress;
      if (ip) ready = await fetch(`http://${ip}:8080/`, { redirect: "manual", signal: AbortSignal.timeout(1500) })
        .then((response) => response.status < 500).catch(() => false);
    }
    return { exists: true, running, ready, session: await this.files.hasSession(id),
      fingerprint: await this.files.fingerprint(id), webUrl };
  }

  async access(id: string): Promise<{ url: string; password: string }> {
    const state = await this.state(id);
    if (!state.ready || !state.webUrl) throw new Error("TASK_NOT_RUNNING");
    return { url: state.webUrl, password: await this.files.webPassword(id) };
  }

  async replaceToken(id: string, token: string): Promise<void> {
    if (!await this.owned(id)) throw new Error("TASK_CONTAINER_MISSING");
    await this.files.writeToken(id, token);
  }

  async resume(id: string, token: string): Promise<void> {
    if (!await this.owned(id) || !await this.owned(id, true)) throw new Error("TASK_CONTAINER_MISSING");
    await this.files.writeToken(id, token);
    await this.start(id);
  }

  async stop(id: string): Promise<void> {
    for (const gateway of [true, false]) {
      const container = await this.owned(id, gateway);
      if (!container?.State.Running) continue;
      try { await this.docker.stop(gateway ? this.gatewayName(id) : this.webName(id)); }
      catch (error) { if (!(error instanceof DockerError && error.status === 304)) throw error; }
    }
  }

  async remove(id: string): Promise<void> {
    await this.stop(id);
    for (const gateway of [true, false]) {
      if (await this.owned(id, gateway)) await this.docker.remove(gateway ? this.gatewayName(id) : this.webName(id));
    }
    await this.files.remove(id, "sandbox");
  }
}
