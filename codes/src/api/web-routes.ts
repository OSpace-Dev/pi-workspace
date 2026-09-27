import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

export function registerWebRoutes(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => reply.redirect("/sandboxes"));
  for (const path of ["/models/connections", "/models/origins"]) {
    app.get(path, async (_request, reply) => reply.type("text/html; charset=utf-8")
      .send(readFileSync(new URL("../../web/index.html", import.meta.url))));
  }
  app.get("/tasks/:id/sources/:sourceId", async (_request, reply) => reply.type("text/html; charset=utf-8")
    .send(readFileSync(new URL("../../web/source.html", import.meta.url))));
  for (const route of ["/tasks", "/tasks/:id"]) {
    app.get(route, async (_request, reply) => reply.type("text/html; charset=utf-8")
      .send(readFileSync(new URL("../../web/tasks.html", import.meta.url))));
  }
  for (const route of ["/sandboxes", "/sandboxes/:id"]) {
    app.get(route, async (_request, reply) => reply.type("text/html; charset=utf-8")
      .send(readFileSync(new URL("../../web/sandboxes.html", import.meta.url))));
  }
  for (const filename of ["app.css", "navigation.css", "tasks.css", "documents.css", "sandboxes.css", "main.js", "tasks-main.js", "sandboxes-main.js", "sandbox-list.js", "sandbox-detail.js", "task-list.js", "task-detail.js", "task-sources.js", "task-answer.js", "source-main.js", "api.js", "ui.js", "session.js", "connections.js", "origins.js"]) {
    app.get(`/${filename}`, async (_request, reply) => reply.type(filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8")
      .send(readFileSync(new URL(`../../web/${filename}`, import.meta.url))));
  }
}
