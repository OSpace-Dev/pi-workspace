import { randomBytes } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, chown, rm, rename } from "node:fs/promises";
import path from "node:path";
import { assertTaskId } from "./task-files.ts";

export class AgentSandboxFiles {
  readonly base: string;
  readonly hostBase: string;
  readonly scope: string;
  constructor(base: string, hostBase: string, scope: string) {
    if (!path.isAbsolute(base) || !hostBase.startsWith("/") || !/^[a-z0-9-]{1,64}$/.test(scope)) {
      throw new Error("INVALID_TASK_DIRECTORY");
    }
    this.base = path.join(base, "autonomous");
    this.hostBase = path.posix.join(hostBase, "autonomous");
    this.scope = scope;
  }
  dir(id: string): string { assertTaskId(id); return path.join(this.base, id); }
  hostDir(id: string): string { assertTaskId(id); return path.posix.join(this.hostBase, id); }
  async exists(id: string): Promise<boolean> {
    try {
      const stat = await lstat(this.dir(id));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_TASK_DIRECTORY");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async owned(id: string): Promise<void> {
    if (!await this.exists(id)) throw new Error("TASK_FILES_MISSING");
    const ownerFile = path.join(this.dir(id), "owner.json");
    if (!(await lstat(ownerFile)).isFile() || (await lstat(ownerFile)).isSymbolicLink()) throw new Error("TASK_OWNER_MISMATCH");
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    if (owner.id !== id || owner.runtime !== "sandbox-v2" || owner.scope !== this.scope) throw new Error("TASK_OWNER_MISMATCH");
    for (const child of ["workspace", "agent"]) {
      const stat = await lstat(path.join(this.dir(id), child));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_TASK_DIRECTORY");
    }
  }
  async prepare(id: string): Promise<void> {
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    if ((await lstat(this.base)).isSymbolicLink()) throw new Error("UNSAFE_TASK_DIRECTORY");
    if (await this.exists(id)) { await this.owned(id); return; }
    const temporary = path.join(this.base, `.prepare-${id}-${randomBytes(8).toString("hex")}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeFile(path.join(temporary, "owner.json"), JSON.stringify({ id, runtime: "sandbox-v2", scope: this.scope }), { mode: 0o600, flag: "wx" });
      for (const child of ["workspace", "agent"]) {
        await mkdir(path.join(temporary, child), { mode: 0o700 });
        await chown(path.join(temporary, child), 10001, 10001);
      }
      await writeFile(path.join(temporary, "web-password"), randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.dir(id));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async password(id: string): Promise<string> {
    await this.owned(id);
    const file = path.join(this.dir(id), "web-password");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("TASK_OWNER_MISMATCH");
    const password = (await readFile(file, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error("TASK_OWNER_MISMATCH");
    return password;
  }
  async remove(id: string): Promise<void> {
    if (!await this.exists(id)) return;
    await this.owned(id);
    await rm(this.dir(id), { recursive: true });
  }
}
