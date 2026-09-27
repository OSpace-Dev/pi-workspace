import { createHash, randomUUID } from "node:crypto";

export class DocumentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}

export type DocumentInput = { id: string; name: string; bytes: Buffer; text: string; sha256: string };
export const documentLimits = { count: 10, fileBytes: 100 * 1024, totalBytes: 300 * 1024 };

export function parseDocuments(value: unknown): DocumentInput[] {
  if (!Array.isArray(value) || !value.length) throw new DocumentError("DOCUMENT_INVALID_INPUT");
  if (value.length > documentLimits.count) throw new DocumentError("DOCUMENT_TOO_MANY", 413);
  const names = new Set<string>();
  const files = value.map((item: unknown) => {
    const input = item as { name?: unknown; base64?: unknown } | null;
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 160 ||
        /[\x00-\x1f\x7f/\\]/.test(input.name) || input.name !== input.name.trim()) {
      throw new DocumentError("DOCUMENT_INVALID_NAME");
    }
    if (!/\.(txt|md|markdown)$/i.test(input.name)) throw new DocumentError("DOCUMENT_UNSUPPORTED");
    if (names.has(input.name)) throw new DocumentError("DOCUMENT_DUPLICATE_NAME", 409);
    names.add(input.name);
    if (typeof input.base64 !== "string" || input.base64.length > Math.ceil(documentLimits.fileBytes / 3) * 4) {
      throw new DocumentError(typeof input.base64 === "string" ? "DOCUMENT_FILE_TOO_LARGE" : "DOCUMENT_INVALID_INPUT",
        typeof input.base64 === "string" ? 413 : 400);
    }
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.toString("base64") !== input.base64) throw new DocumentError("DOCUMENT_INVALID_INPUT");
    if (bytes.length > documentLimits.fileBytes) throw new DocumentError("DOCUMENT_FILE_TOO_LARGE", 413);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new DocumentError("DOCUMENT_INVALID_ENCODING"); }
    if (text.includes("\0")) throw new DocumentError("DOCUMENT_INVALID_ENCODING");
    if (!text.trim()) throw new DocumentError("DOCUMENT_EMPTY");
    return { id: randomUUID(), name: input.name, bytes, text, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > documentLimits.totalBytes) {
    throw new DocumentError("DOCUMENT_TOTAL_TOO_LARGE", 413);
  }
  return files;
}
