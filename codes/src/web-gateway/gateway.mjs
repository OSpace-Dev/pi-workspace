import http from "node:http";
import net from "node:net";

const host = process.env.SANDBOX_HOST;
if (!/^piws-sandbox-[0-9a-f-]{36}$/.test(host ?? "")) throw new Error("INVALID_SANDBOX_HOST");
const target = { host, port: 30141 };
function trustedHeaders(incoming) {
  const origin = incoming.headers.origin;
  if (origin && origin !== `http://${incoming.headers.host}`) return null;
  const headers = { ...incoming.headers, host: `${host}:30141` };
  if (origin) headers.origin = `http://${host}:30141`;
  if (incoming.headers.referer?.startsWith(`http://${incoming.headers.host}/`)) {
    headers.referer = incoming.headers.referer.replace(`http://${incoming.headers.host}/`, `http://${host}:30141/`);
  }
  return headers;
}
const server = http.createServer((incoming, outgoing) => {
  const headers = trustedHeaders(incoming);
  if (!headers) { outgoing.writeHead(403); outgoing.end(); return; }
  const upstream = http.request({ ...target, method: incoming.method, path: incoming.url, headers }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
});
server.on("upgrade", (incoming, socket, head) => {
  const headers = trustedHeaders(incoming);
  if (!headers) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
  const upstream = net.connect(target.port, target.host);
  upstream.on("connect", () => {
    const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) lines.push(`${key}: ${key === "host" ? `${host}:30141` : value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(8080, "0.0.0.0");
