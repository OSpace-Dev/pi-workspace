import http from "node:http";

export type Container = {
  Id: string;
  State: { Running: boolean; Status: string };
  Config: { Image: string; User: string; Labels: Record<string, string> };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
  HostConfig: { Privileged: boolean; ReadonlyRootfs: boolean; CapDrop: string[];
    SecurityOpt: string[]; PortBindings: Record<string, { HostIp: string; HostPort: string }[]> | null };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
};

export class DockerError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`Docker ${operation} returned ${status}`);
    this.status = status; this.operation = operation;
  }
}

export type DockerNetwork = { Name: string; Driver: string; Internal: boolean; Labels: Record<string, string> };

export class DockerEngine {
  private readonly socketPath: string;
  constructor(socketPath = "/var/run/docker.sock") { this.socketPath = socketPath; }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = http.request({
        socketPath: this.socketPath, path: `/v1.41${path}`, method,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
        timeout: 20_000,
      }, (response) => {
        response.on("error", reject);
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) response.destroy(new Error("DOCKER_RESPONSE_TOO_LARGE"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) return reject(new DockerError(status, `${method} ${path}`));
          const text = Buffer.concat(chunks).toString("utf8");
          try { resolve((text ? JSON.parse(text) : undefined) as T); }
          catch { reject(new Error("INVALID_DOCKER_RESPONSE")); }
        });
      });
      request.on("timeout", () => request.destroy(new Error("DOCKER_TIMEOUT")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  async inspect(name: string): Promise<Container | null> {
    try { return await this.request<Container>("GET", `/containers/${encodeURIComponent(name)}/json`); }
    catch (error) { if (error instanceof DockerError && error.status === 404) return null; throw error; }
  }

  create(name: string, configuration: unknown): Promise<{ Id: string }> {
    return this.request("POST", `/containers/create?name=${encodeURIComponent(name)}`, configuration);
  }

  start(name: string): Promise<void> {
    return this.request("POST", `/containers/${encodeURIComponent(name)}/start`);
  }

  stop(name: string): Promise<void> {
    return this.request("POST", `/containers/${encodeURIComponent(name)}/stop?t=8`);
  }

  remove(name: string): Promise<void> {
    return this.request("DELETE", `/containers/${encodeURIComponent(name)}?v=false`);
  }

  connect(network: string, name: string): Promise<void> {
    return this.request("POST", `/networks/${encodeURIComponent(network)}/connect`, { Container: name });
  }

  async inspectNetwork(name: string): Promise<DockerNetwork | null> {
    try { return await this.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(name)}`); }
    catch (error) { if (error instanceof DockerError && error.status === 404) return null; throw error; }
  }

  createNetwork(name: string, labels: Record<string, string>): Promise<{ Id: string }> {
    return this.request("POST", "/networks/create", { Name: name, Driver: "bridge", Internal: false, CheckDuplicate: true, Labels: labels });
  }

  removeNetwork(name: string): Promise<void> {
    return this.request("DELETE", `/networks/${encodeURIComponent(name)}`);
  }
}
