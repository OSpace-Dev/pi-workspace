import assert from "node:assert/strict";
import test from "node:test";
import { PiRequestError, validatePiRequest } from "./pi-request.ts";

const valid = {
  model: "synthetic-model", messages: [{ role: "user", content: "hello" }], stream: true,
  stream_options: { include_usage: true }, max_completion_tokens: 128,
};

test("accepts the measured text-only Pi request", () => {
  assert.deepEqual(JSON.parse(validatePiRequest(valid, valid.model).toString()), valid);
  assert.equal(JSON.parse(validatePiRequest({ ...valid, max_completion_tokens: undefined }, valid.model).toString()).max_completion_tokens, 4096);
  assert.doesNotThrow(() => validatePiRequest({ ...valid, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }, valid.model));
});

test("rejects request overrides, tools, images, wrong model, and excessive output", () => {
  for (const changed of [
    { ...valid, upstreamUrl: "https://evil.test" },
    { ...valid, tools: [] },
    { ...valid, stream: false },
    { ...valid, max_completion_tokens: 4097 },
    { ...valid, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }] }] },
    { ...valid, messages: [{ role: "assistant", content: "", tool_calls: [] }] },
  ]) {
    assert.throws(() => validatePiRequest(changed, valid.model), (error: unknown) =>
      error instanceof PiRequestError && error.code === "INVALID_REQUEST");
  }
  assert.throws(() => validatePiRequest({ ...valid, model: "other" }, valid.model), (error: unknown) =>
    error instanceof PiRequestError && error.code === "MODEL_MISMATCH");
});

test("sandbox accepts bounded function tools and rejects them in QA", () => {
  const withTools = { ...valid,
    messages: [
      { role: "system", content: "help" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function",
        function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "sample" },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
    tools: [{ type: "function", function: { name: "read", description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } } } }],
  };
  assert.deepEqual(JSON.parse(validatePiRequest(withTools, valid.model, true).toString()), withTools);
  assert.throws(() => validatePiRequest(withTools, valid.model), PiRequestError);
  assert.throws(() => validatePiRequest({ ...withTools, tools: [{ type: "function", function: { name: "bad name", parameters: {} } }] }, valid.model, true), PiRequestError);
});
