import { randomBytes } from "node:crypto";
import { chownSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const directory = process.argv[2];
if (!directory) throw new Error("Secret directory argument required");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const owner = Number(process.env.HOST_UID);
const group = Number(process.env.HOST_GID);
if (!Number.isSafeInteger(owner) || !Number.isSafeInteger(group) || owner < 0 || group < 0) {
  throw new Error("Valid host UID and GID are required");
}
chownSync(directory, owner, group);
chmodSync(directory, 0o700);
for (const [name, bytes, encoding] of [
  ["postgres-password", 32, "base64url"],
  ["admin-key", 32, "base64url"],
  ["service-key", 32, "base64url"],
  ["master-key", 32, null],
]) {
  const path = `${directory}/${name}`;
  if (!existsSync(path)) {
    const value = encoding ? `${randomBytes(bytes).toString(encoding)}\n` : randomBytes(bytes);
    writeFileSync(path, value, { flag: "wx", mode: 0o600 });
    console.log(`Created ${name}`);
  }
  chownSync(path, owner, group);
  chmodSync(path, 0o600);
}
