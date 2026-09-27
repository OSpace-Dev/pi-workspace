import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { Pool } from "pg";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const password = readFileSync(requiredEnvironment("DB_PASSWORD_FILE"), "utf8").trim();
if (!password) {
  throw new Error("Database password file is empty");
}

const app = Fastify({ logger: true });
const database = new Pool({
  host: requiredEnvironment("DB_HOST"),
  port: Number(process.env.DB_PORT ?? 5432),
  user: requiredEnvironment("DB_USER"),
  database: requiredEnvironment("DB_NAME"),
  password,
  max: 5,
  connectionTimeoutMillis: 2_000,
});

database.on("error", (error) => {
  app.log.error({ error }, "Idle database connection failed");
});

app.get("/health", async () => ({ status: "ok", service: "control-api" }));

app.get("/ready", async (_request, reply) => {
  try {
    await database.query("SELECT 1");
    return { status: "ready" };
  } catch {
    app.log.warn("Database readiness check failed");
    return reply.code(503).send({ status: "unavailable" });
  }
});

app.addHook("onClose", async () => {
  await database.end();
});

try {
  await app.listen({ host: "0.0.0.0", port: 3000 });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
