const allowedKeys = new Set(["model", "messages", "stream", "stream_options", "max_completion_tokens"]);
const allowedRoles = new Set(["system", "developer", "user", "assistant"]);

export class PiRequestError extends Error {
  readonly code: "INVALID_REQUEST" | "MODEL_MISMATCH";
  constructor(code: PiRequestError["code"]) {
    super(code);
    this.name = "PiRequestError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.length > 0 && value.every((part) => {
    const item = record(part);
    return item && Object.keys(item).length === 2 && item.type === "text" && typeof item.text === "string";
  });
}

function validQaMessage(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && Object.keys(item).length === 2 && typeof item.role === "string" &&
    allowedRoles.has(item.role) && textContent(item.content));
}

function validToolCalls(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((call) => {
    const item = record(call);
    const fn = record(item?.function);
    return item && Object.keys(item).length === 3 && item.type === "function" &&
      typeof item.id === "string" && item.id.length > 0 && item.id.length <= 200 &&
      fn && Object.keys(fn).length === 2 && typeof fn.name === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(fn.name) && typeof fn.arguments === "string";
  });
}

function validSandboxMessage(value: unknown): boolean {
  const item = record(value);
  if (!item || typeof item.role !== "string") return false;
  if (item.role === "tool") return Object.keys(item).every((key) => ["role", "content", "tool_call_id", "name"].includes(key)) &&
    typeof item.content === "string" && typeof item.tool_call_id === "string" &&
    item.tool_call_id.length > 0 && item.tool_call_id.length <= 200 &&
    (item.name === undefined || typeof item.name === "string");
  if (!allowedRoles.has(item.role)) return false;
  if (item.role === "assistant" && item.tool_calls !== undefined) {
    return Object.keys(item).every((key) => ["role", "content", "tool_calls"].includes(key)) &&
      (item.content === null || textContent(item.content)) && validToolCalls(item.tool_calls);
  }
  return Object.keys(item).length === 2 && textContent(item.content);
}

function validToolDefinitions(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 32 && value.every((tool) => {
    const item = record(tool);
    const fn = record(item?.function);
    return item && Object.keys(item).length === 2 && item.type === "function" && fn &&
      Object.keys(fn).every((key) => ["name", "description", "parameters", "strict"].includes(key)) &&
      typeof fn.name === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(fn.name) &&
      (fn.description === undefined || typeof fn.description === "string") &&
      record(fn.parameters) !== null && (fn.strict === undefined || typeof fn.strict === "boolean");
  });
}

export function validatePiRequest(value: unknown, expectedModel: string, sandbox = false): Buffer {
  const body = record(value);
  if (!body || Object.keys(body).some((key) => !allowedKeys.has(key) &&
    !(sandbox && ["tools", "tool_choice"].includes(key))) || body.stream !== true) {
    throw new PiRequestError("INVALID_REQUEST");
  }
  if (body.model !== expectedModel) throw new PiRequestError("MODEL_MISMATCH");
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 64 ||
      !body.messages.every((message) => sandbox ? validSandboxMessage(message) : validQaMessage(message))) {
    throw new PiRequestError("INVALID_REQUEST");
  }
  if (sandbox && body.tools !== undefined && !validToolDefinitions(body.tools)) throw new PiRequestError("INVALID_REQUEST");
  if (sandbox && body.tool_choice !== undefined &&
    !["auto", "none", "required"].includes(String(body.tool_choice))) throw new PiRequestError("INVALID_REQUEST");
  if (body.stream_options !== undefined) {
    const options = record(body.stream_options);
    if (!options || Object.keys(options).length !== 1 || options.include_usage !== true) {
      throw new PiRequestError("INVALID_REQUEST");
    }
  }
  if (body.max_completion_tokens !== undefined &&
      (!Number.isInteger(body.max_completion_tokens) || Number(body.max_completion_tokens) < 1 ||
        Number(body.max_completion_tokens) > 4096)) throw new PiRequestError("INVALID_REQUEST");
  const encoded = Buffer.from(JSON.stringify({ ...body, max_completion_tokens: body.max_completion_tokens ?? 4096 }));
  if (encoded.length > 1024 * 1024) throw new PiRequestError("INVALID_REQUEST");
  return encoded;
}
