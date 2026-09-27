import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, lstat, readdir, rm, chown, writeFile } from "node:fs/promises";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTaskId(value: string): void {
  if (!uuid.test(value)) throw new Error("INVALID_TASK_ID");
}

export class TaskFiles {
  readonly base: string;
  readonly hostBase: string;
  constructor(base: string, hostBase: string) {
    if (!path.isAbsolute(base) || !hostBase.startsWith("/")) throw new Error("INVALID_TASK_DIRECTORY");
    this.base = base; this.hostBase = hostBase;
  }

  private dir(taskId: string): string { assertTaskId(taskId); return path.join(this.base, taskId); }
  hostDir(taskId: string): string { assertTaskId(taskId); return path.posix.join(this.hostBase, taskId); }

  async exists(taskId: string): Promise<boolean> {
    try {
      const stat = await lstat(this.dir(taskId));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_TASK_DIRECTORY");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async readOwner(taskId: string): Promise<{ taskId: string; modelId: string; kind: "qa" | "sandbox" }> {
    if (!await this.exists(taskId)) throw new Error("TASK_FILES_MISSING");
    const owner = JSON.parse(await readFile(path.join(this.dir(taskId), "owner.json"), "utf8"));
    if (owner.taskId !== taskId || typeof owner.modelId !== "string") throw new Error("TASK_OWNER_MISMATCH");
    if (owner.kind !== undefined && owner.kind !== "qa" && owner.kind !== "sandbox") throw new Error("TASK_OWNER_MISMATCH");
    return { ...owner, kind: owner.kind ?? "qa" };
  }

  async prepare(taskId: string, modelId: string, token: string, kind: "qa" | "sandbox" = "qa"): Promise<string> {
    assertTaskId(taskId);
    if (!modelId || Buffer.byteLength(modelId) > 200 || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("INVALID_TASK_CONFIG");
    }
    if (await this.exists(taskId)) {
      const owner = await this.readOwner(taskId);
      if (owner.modelId !== modelId || owner.kind !== kind) throw new Error("TASK_OWNER_MISMATCH");
      return await readFile(path.join(this.dir(taskId), "worker-key"), "utf8");
    }
    const root = this.dir(taskId);
    await mkdir(root, { mode: 0o700 });
    await mkdir(path.join(root, "workspace"), { mode: 0o700 });
    await mkdir(path.join(root, "agent"), { mode: 0o700 });
    await mkdir(path.join(root, "token"), { mode: 0o755 });
    await chown(path.join(root, "workspace"), 10001, 10001);
    await chown(path.join(root, "agent"), 10001, 10001);
    if (kind === "qa") {
      await writeFile(path.join(root, "workspace", "session.jsonl"), "", { mode: 0o600 });
      await chown(path.join(root, "workspace", "session.jsonl"), 10001, 10001);
    }
    await writeFile(path.join(root, "owner.json"), JSON.stringify({ taskId, modelId, kind }), { mode: 0o600 });
    const workerKey = randomBytes(32).toString("base64url");
    await writeFile(path.join(root, "worker-key"), workerKey, { mode: 0o600 });
    await writeFile(path.join(root, "agent", "settings.json"), JSON.stringify({
      defaultProvider: "workspace", defaultModel: modelId, defaultThinkingLevel: "off",
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }), { mode: 0o600 });
    await writeFile(path.join(root, "agent", "models.json"), JSON.stringify({ providers: { workspace: {
      baseUrl: "http://proxy:3001/v1", api: "openai-completions",
      apiKey: "!cat /run/piws-token/current",
      models: [{ id: modelId, maxTokens: 4096, compat: { supportsStore: false, supportsReasoningEffort: false } }],
    } } }), { mode: 0o600 });
    await chown(path.join(root, "agent", "settings.json"), 10001, 10001);
    await chown(path.join(root, "agent", "models.json"), 10001, 10001);
    await this.writeToken(taskId, token);
    return workerKey;
  }

  async writeToken(taskId: string, token: string): Promise<void> {
    await this.readOwner(taskId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("INVALID_TASK_TOKEN");
    const dir = path.join(this.dir(taskId), "token");
    const temporary = path.join(dir, `.current-${randomBytes(8).toString("hex")}`);
    const file = await open(temporary, "wx", 0o444);
    try { await file.writeFile(`${token}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path.join(dir, "current"));
    const parent = await open(dir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }

  async fingerprint(taskId: string): Promise<string> {
    await this.readOwner(taskId);
    const token = (await readFile(path.join(this.dir(taskId), "token", "current"), "utf8")).trim();
    return createHash("sha256").update(token).digest("hex");
  }

  async hasSession(taskId: string): Promise<boolean> {
    const owner = await this.readOwner(taskId);
    const stored = owner.kind === "sandbox" ? path.join(this.dir(taskId), "agent") :
      path.join(this.dir(taskId), "workspace", "session.jsonl");
    try { const stat = await lstat(stored); return owner.kind === "sandbox" ? stat.isDirectory() : stat.isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  async webPassword(taskId: string, create = false): Promise<string> {
    if ((await this.readOwner(taskId)).kind !== "sandbox") throw new Error("TASK_OWNER_MISMATCH");
    const file = path.join(this.dir(taskId), "web-password");
    try { return (await readFile(file, "utf8")).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      const password = randomBytes(32).toString("base64url");
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(password); } finally { await handle.close(); }
      return password;
    }
  }

  async remove(taskId: string, kind: "qa" | "sandbox" = "qa"): Promise<void> {
    if (!await this.exists(taskId)) return;
    if ((await this.readOwner(taskId)).kind !== kind) throw new Error("TASK_OWNER_MISMATCH");
    const root = this.dir(taskId);
    for (const entry of await readdir(root)) {
      if (!["owner.json", "worker-key", "web-password", "workspace", "agent", "token"].includes(entry)) {
        throw new Error("UNKNOWN_TASK_ENTRY");
      }
    }
    await rm(root, { recursive: true });
  }
}
