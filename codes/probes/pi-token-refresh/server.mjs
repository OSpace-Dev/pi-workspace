import { createServer } from "node:http";

let generation = "old";
let accepted = 0;

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200);
    response.end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const expected = generation === "old" ? "probe-token-old" : "probe-token-new";
  if (request.headers.authorization !== `Bearer ${expected}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "UNAUTHORIZED" } }));
    return;
  }
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("TOO_LARGE");
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (body.model !== "probe-a" || body.stream !== true) {
    response.writeHead(400).end();
    return;
  }
  const usedGeneration = generation;
  accepted += 1;
  generation = "new";
  process.stdout.write(`${JSON.stringify({ generation: usedGeneration, accepted })}\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finishReason = null) => ({
    id: "refresh-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "probe-a",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({ content: "Synthetic answer." }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
  response.end("data: [DONE]\n\n");
});

server.listen(4100, "0.0.0.0");
