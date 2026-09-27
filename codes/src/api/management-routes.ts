import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function registerManagementRoutes(app: FastifyInstance, managementUrl: string, serviceKey: string): void {
  async function forward(request: FastifyRequest, reply: FastifyReply) {
    try {
      const response = await fetch(`${managementUrl}${request.url.replace("/api/v1/", "/internal/")}`, {
        method: request.method,
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: request.method === "GET" ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      const data: unknown = await response.json();
      return reply.code(response.status).send(data);
    } catch {
      return reply.code(503).send({ error: { code: "MANAGEMENT_UNAVAILABLE" } });
    }
  }
  app.get("/api/v1/origins", forward);
  app.post("/api/v1/origins", forward);
  app.get("/api/v1/connections", forward);
  app.post("/api/v1/connections", forward);
  app.patch("/api/v1/connections/:id/disable", forward);
  app.patch("/api/v1/connections/:id/credential", forward);
}
