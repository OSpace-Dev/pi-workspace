import Fastify from "fastify";
import { AdminSessions, equalSecret } from "./admin-session.ts";
import { registerManagementRoutes } from "./management-routes.ts";
import { registerWebRoutes } from "./web-routes.ts";
import { registerTaskRoutes } from "./task-routes.ts";
import { TaskServiceError, type TaskService } from "./task-service.ts";
import { InternalServiceError } from "./task-clients.ts";
import { DocumentError } from "./document-input.ts";
import { registerDocumentRoutes } from "./document-routes.ts";
import type { DocumentStore } from "./document-store.ts";
import { registerSandboxRoutes } from "./sandbox-routes.ts";
import type { AgentSandboxService } from "./agent-sandbox-service.ts";

export function buildManagementApi(options: {
  adminKey: string; serviceKey: string; publicOrigin: string; managementUrl: string;
  tasks?: TaskService;
  documents?: DocumentStore;
  agents?: AgentSandboxService;
}) {
  if (options.adminKey.length < 32 || options.serviceKey.length < 32) throw new Error("Invalid management key");
  const expectedHost = new URL(options.publicOrigin).host;
  const sessions = new AdminSessions(options.adminKey, options.publicOrigin);
  const app = Fastify({ logger: false, bodyLimit: 40 * 1024 });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.headers.host !== expectedHost) return reply.code(403).send({ error: { code: "INVALID_HOST" } });
    if (!["GET", "HEAD"].includes(request.method) && request.headers.origin !== options.publicOrigin) {
      return reply.code(403).send({ error: { code: "INVALID_ORIGIN" } });
    }
    if (request.url.startsWith("/api/v1/") && !["/api/v1/login", "/api/v1/session"].includes(request.url)) {
      const current = sessions.current(request);
      if (!current) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
      if (!["GET", "HEAD"].includes(request.method) && !equalSecret(String(request.headers["x-csrf-token"] ?? ""), current.csrf)) {
        return reply.code(403).send({ error: { code: "INVALID_CSRF" } });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DocumentError) return reply.code(error.status).send({ error: { code: error.code } });
    if (error instanceof TaskServiceError) return reply.code(error.status).send({ error: { code: error.code } });
    if (error instanceof InternalServiceError) return reply.code(503).send({ error: { code: "TASK_SERVICE_UNAVAILABLE" } });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500)
      .send({ error: { code: status && status < 500 ? "INVALID_INPUT" : "INTERNAL_ERROR" } });
  });
  registerWebRoutes(app);
  sessions.register(app);
  registerManagementRoutes(app, options.managementUrl, options.serviceKey);
  if (options.tasks) registerTaskRoutes(app, options.tasks);
  if (options.tasks) registerSandboxRoutes(app, options.tasks, options.agents);
  if (options.documents) registerDocumentRoutes(app, options.documents);
  app.get("/health", async () => ({ status: "ok", service: "management-api" }));
  return app;
}
