import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = join(process.cwd(), ".local");
const file = join(directory, "postgres-password");

mkdirSync(directory, { recursive: true });
if (!existsSync(file)) {
  writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Created local PostgreSQL password file");
} else {
  console.log("Local PostgreSQL password file already exists");
}
