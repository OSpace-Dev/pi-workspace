import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import https from "node:https";
import test from "node:test";
import tls from "node:tls";
import { once } from "node:events";
import { postChatCompletionStream, UpstreamTransportError } from "./https-transport.ts";
import type { AllowedDestination } from "./upstream-policy.ts";

const certificate = readFileSync(new URL("./fixtures/api.example.test-cert.pem", import.meta.url), "utf8");
const privateKey = readFileSync(new URL("./fixtures/api.example.test-key.pem", import.meta.url), "utf8");
tls.setDefaultCACertificates([certificate]);

const body = Buffer.from('{"stream":true}');
const timeouts = { firstResponseTimeoutMs: 1000, idleTimeoutMs: 1000 };

function destination(port: number, hostname = "api.example.test"): AllowedDestination {
  return {
    baseUrl: `https://${hostname}:${port}/v1`,
    origin: `https://${hostname}:${port}`,
    hostname,
    address: "127.0.0.1",
    family: 4,
  };
}

async function withServer(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
  action: (port: number) => Promise<void>,
): Promise<void> {
  const server = https.createServer({ key: privateKey, cert: certificate }, handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await action(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function expectCode(action: () => Promise<unknown>, code: UpstreamTransportError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof UpstreamTransportError && error.code === code && error.message === code);
}

test("streams over the selected IP with original Host, SNI, and verified hostname", async () => {
  let requestCount = 0;
  await withServer((request, response) => {
    requestCount++;
    assert.equal(request.socket.remoteAddress, "127.0.0.1");
    assert.equal((request.socket as tls.TLSSocket).servername, "api.example.test");
    assert.equal(request.headers.host, `api.example.test:${request.socket.localPort}`);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer synthetic-upstream-key");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write("data: first\n\n");
    setTimeout(() => response.end("data: [DONE]\n\n"), 10);
  }, async (port) => {
    const stream = await postChatCompletionStream(destination(port), body, { ...timeouts, credential: "synthetic-upstream-key" });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "data: first\n\ndata: [DONE]\n\n");
  });
  assert.equal(requestCount, 1);
});

test("rejects redirects without following Location or exposing response data", async () => {
  let requestCount = 0;
  await withServer((_request, response) => {
    requestCount++;
    response.writeHead(307, { location: "https://other.example.test/private" });
    response.end("sensitive body");
  }, async (port) => {
    await expectCode(() => postChatCompletionStream(destination(port), body, timeouts), "REDIRECT_REJECTED");
  });
  assert.equal(requestCount, 1);
});

test("rejects upstream failure and invalid content type without response text", async () => {
  await withServer((_request, response) => {
    response.writeHead(403, { "content-type": "text/plain", "x-secret": "sensitive header" });
    response.end("sensitive body");
  }, async (port) => {
    await expectCode(() => postChatCompletionStream(destination(port), body, timeouts), "UPSTREAM_STATUS");
  });
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"secret":"sensitive body"}');
  }, async (port) => {
    await expectCode(() => postChatCompletionStream(destination(port), body, timeouts), "INVALID_CONTENT_TYPE");
  });
});

test("verifies both hostname and certificate trust", async () => {
  await withServer((_request, response) => response.end("unused"), async (port) => {
    await expectCode(() => postChatCompletionStream(destination(port, "wrong.example.test"), body, timeouts), "CONNECTION_FAILED");
    tls.setDefaultCACertificates([]);
    try {
      await expectCode(() => postChatCompletionStream(destination(port), body, timeouts), "CONNECTION_FAILED");
    } finally {
      tls.setDefaultCACertificates([certificate]);
    }
  });
});

test("first response and stream idle deadlines abort the connection", async () => {
  await withServer(() => {}, async (port) => {
    await expectCode(() => postChatCompletionStream(destination(port), body, { ...timeouts, firstResponseTimeoutMs: 40 }), "FIRST_RESPONSE_TIMEOUT");
  });
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  }, async (port) => {
    const stream = await postChatCompletionStream(destination(port), body, { ...timeouts, idleTimeoutMs: 40 });
    await expectCode(async () => {
      for await (const _chunk of stream) { /* consume until idle failure */ }
    }, "IDLE_TIMEOUT");
  });
});

test("abort signal cancels an active stream", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  }, async (port) => {
    const controller = new AbortController();
    const stream = await postChatCompletionStream(destination(port), body, { ...timeouts, signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.toString(), "data: first\n\n");
    controller.abort();
    await expectCode(() => iterator.next(), "CANCELLED");
  });
});

test("reports an interrupted SSE response as a stream failure", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: partial\n\n");
    setTimeout(() => response.socket?.destroy(), 10);
  }, async (port) => {
    const stream = await postChatCompletionStream(destination(port), body, timeouts);
    await expectCode(async () => {
      for await (const _chunk of stream) { /* consume until remote disconnect */ }
    }, "STREAM_FAILURE");
  });
});
