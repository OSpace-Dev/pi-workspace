import type { FastifyInstance } from "fastify";
import { DocumentStore } from "./document-store.ts";
import { parseDocuments } from "./document-input.ts";

export function registerDocumentRoutes(app: FastifyInstance, documents: DocumentStore): void {
  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id/sources", async (request) => ({
    items: (await documents.list(request.params.id)).map(({ text: _text, ...metadata }) => metadata),
  }));
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/sources", { bodyLimit: 450 * 1024 }, async (request, reply) => {
    const files = parseDocuments((request.body as { files?: unknown } | undefined)?.files);
    const items = await documents.add(request.params.id, files);
    return reply.code(201).send({ items: items.map(({ text: _text, ...metadata }) => metadata) });
  });
  app.get<{ Params: { id: string; sourceId: string } }>("/api/v1/tasks/:id/sources/:sourceId", async (request) => ({
    source: await documents.get(request.params.id, request.params.sourceId),
  }));
}
