import http from "node:http";
let calls = 0;
http.createServer((request, response) => {
  if (request.url === "/count") { response.end(JSON.stringify({ calls })); return; }
  if (request.url === "/v1/models") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "independent-test", object: "model" }] })); return;
  }
  if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
  let size = 0;
  request.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); });
  request.on("end", () => {
    calls++;
    response.setHeader("Content-Type", "text/event-stream");
    for (const item of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Independent sandbox answer." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]) response.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "independent-test", ...item })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
}).listen(30300, "0.0.0.0");
