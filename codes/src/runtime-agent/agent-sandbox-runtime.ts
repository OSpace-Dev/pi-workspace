import path from "node:path";
import { DockerEngine, DockerError, type Container } from "./docker-engine.ts";
import { AgentSandboxFiles } from "./agent-sandbox-files.ts";
import { assertTaskId } from "./task-files.ts";

export class AgentSandboxRuntime {
  private readonly docker: DockerEngine;
  private readonly files: AgentSandboxFiles;
  private readonly image: string;
  private readonly gatewayImage: string;
  private readonly managementNetwork: string;
  constructor(docker: DockerEngine, files: AgentSandboxFiles, image: string, gatewayImage: string, managementNetwork: string) {
    this.docker = docker; this.files = files; this.image = image;
    this.gatewayImage = gatewayImage; this.managementNetwork = managementNetwork;
  }
  private name(id: string, gateway = false) { assertTaskId(id); return `piws-sandbox-${gateway ? "gateway-" : ""}${id}`; }
  private network(id: string) { assertTaskId(id); return `piws-agent-${id}`; }
  private labels(id: string, role: string) {
    return { "piws.task.id": id, "piws.runtime": "sandbox-v2", "piws.scope": this.files.scope, "piws.role": role };
  }
  private async ownedNetwork(id: string) {
    const network = await this.docker.inspectNetwork(this.network(id));
    if (network && (network.Driver !== "bridge" || network.Internal ||
      Object.entries(this.labels(id, "network")).some(([key, value]) => network.Labels?.[key] !== value))) {
      throw new Error("CONTAINER_OWNER_MISMATCH");
    }
    return network;
  }
  private async owned(id: string, gateway = false): Promise<Container | null> {
    const container = await this.docker.inspect(this.name(id, gateway));
    if (!container) return null;
    await this.files.owned(id);
    const config = container.HostConfig;
    const networks = Object.keys(container.NetworkSettings.Networks);
    const expectedNetworks = gateway ? [this.managementNetwork, this.network(id)] : [this.network(id)];
    if (container.Config.Image !== (gateway ? this.gatewayImage : this.image) ||
      Object.entries(this.labels(id, gateway ? "gateway" : "web")).some(([key, value]) => container.Config.Labels?.[key] !== value) ||
      container.Config.User !== "10001:10001" || config.Privileged || !config.ReadonlyRootfs ||
      !config.CapDrop?.includes("ALL") || !config.SecurityOpt?.includes("no-new-privileges:true") ||
      networks.some((network) => !expectedNetworks.includes(network))) throw new Error("CONTAINER_OWNER_MISMATCH");
    if (!gateway) {
      const root = this.files.hostDir(id);
      const mounts = new Map(container.Mounts.map((mount) => [mount.Destination, mount]));
      if (mounts.size !== 2 || mounts.get("/workspace")?.Source !== path.posix.join(root, "workspace") ||
        !mounts.get("/workspace")?.RW || mounts.get("/data/pi-agent")?.Source !== path.posix.join(root, "agent") ||
        !mounts.get("/data/pi-agent")?.RW || Object.keys(config.PortBindings ?? {}).length ||
        !networks.includes(this.network(id))) throw new Error("CONTAINER_OWNER_MISMATCH");
    } else if (container.Mounts.length || !networks.includes(this.managementNetwork) ||
      Object.keys(config.PortBindings ?? {}).join() !== "8080/tcp" ||
      config.PortBindings?.["8080/tcp"]?.length !== 1 || config.PortBindings["8080/tcp"][0]?.HostIp !== "127.0.0.1") {
      throw new Error("CONTAINER_OWNER_MISMATCH");
    }
    return container;
  }
  async prepare(id: string): Promise<void> {
    await this.files.prepare(id);
    if (!await this.ownedNetwork(id)) await this.docker.createNetwork(this.network(id), this.labels(id, "network"));
    if (!await this.owned(id)) {
      const root = this.files.hostDir(id);
      await this.docker.create(this.name(id), {
        Image: this.image, User: "10001:10001", WorkingDir: "/workspace",
        Cmd: ["pi-web", "--hostname", "0.0.0.0", "--port", "30141", "--no-open"],
        Env: ["PI_CODING_AGENT_DIR=/data/pi-agent", "HOME=/workspace", `PI_WEB_PASSWORD=${await this.files.password(id)}`,
          "PI_WEB_SKIP_VERSION_CHECK=1", `PI_WEB_ALLOWED_HOSTS=${this.name(id)}`],
        Labels: this.labels(id, "web"),
        HostConfig: { NetworkMode: this.network(id), Dns: ["8.8.8.8"],
          Binds: [`${root}/workspace:/workspace:rw`, `${root}/agent:/data/pi-agent:rw`],
          ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          Memory: 768 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128,
          Tmpfs: { "/tmp": "rw,nosuid,noexec,size=67108864" }, Init: true },
      });
    }
    if (!await this.owned(id, true)) {
      await this.docker.create(this.name(id, true), {
        Image: this.gatewayImage, User: "10001:10001", Env: [`SANDBOX_HOST=${this.name(id)}`],
        ExposedPorts: { "8080/tcp": {} }, Labels: this.labels(id, "gateway"),
        HostConfig: { NetworkMode: this.managementNetwork,
          PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
          ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          Memory: 128 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 64, Init: true },
      });
    }
    if (!(await this.owned(id, true))?.NetworkSettings.Networks[this.network(id)]) {
      await this.docker.connect(this.network(id), this.name(id, true));
    }
    await this.start(id);
  }
  private async start(id: string): Promise<void> {
    if (!await this.ownedNetwork(id)) throw new Error("TASK_CONTAINER_MISSING");
    for (const gateway of [false, true]) {
      const container = await this.owned(id, gateway);
      if (!container || !container.NetworkSettings.Networks[this.network(id)]) throw new Error("TASK_CONTAINER_MISSING");
      if (!container.State.Running) await this.docker.start(this.name(id, gateway));
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await this.state(id)).ready) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("PI_START_TIMEOUT");
  }
  async state(id: string) {
    const web = await this.owned(id);
    const gateway = await this.owned(id, true);
    if (web || gateway) await this.ownedNetwork(id);
    const binding = gateway?.NetworkSettings.Ports?.["8080/tcp"]?.find((port) => port.HostIp === "127.0.0.1");
    const webUrl = binding && /^\d+$/.test(binding.HostPort) ? `http://127.0.0.1:${binding.HostPort}` : null;
    const running = Boolean(web?.State.Running && gateway?.State.Running);
    const ip = gateway?.NetworkSettings.Networks[this.managementNetwork]?.IPAddress;
    const ready = running && Boolean(ip) && await fetch(`http://${ip}:8080/`, { redirect: "manual", signal: AbortSignal.timeout(1500) })
      .then((response) => response.status >= 200 && response.status < 400).catch(() => false);
    return { exists: Boolean(web || gateway), running, ready, webUrl,
      containerState: web?.State.Status ?? "missing", observedAt: new Date().toISOString(),
      errorCode: running && !ready ? "PI_WEB_NOT_READY" : null };
  }
  async access(id: string) {
    const state = await this.state(id);
    if (!state.ready || !state.webUrl) throw new Error("TASK_NOT_RUNNING");
    return { url: state.webUrl, password: await this.files.password(id) };
  }
  async resume(id: string): Promise<void> { await this.files.owned(id); await this.start(id); }
  async stop(id: string): Promise<void> {
    for (const gateway of [true, false]) {
      const container = await this.owned(id, gateway);
      if (!container?.State.Running) continue;
      try { await this.docker.stop(this.name(id, gateway)); }
      catch (error) { if (!(error instanceof DockerError && error.status === 304)) throw error; }
    }
  }
  async remove(id: string): Promise<void> {
    await this.ownedNetwork(id);
    await this.owned(id);
    await this.owned(id, true);
    await this.stop(id);
    for (const gateway of [true, false]) {
      if (await this.owned(id, gateway)) await this.docker.remove(this.name(id, gateway));
    }
    if (await this.ownedNetwork(id)) await this.docker.removeNetwork(this.network(id));
    await this.files.remove(id);
  }
}
