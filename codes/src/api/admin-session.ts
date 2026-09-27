import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

export function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export class AdminSessions {
  private readonly sessions = new Map<string, { csrf: string; expires: number }>();
  private failedLogins = 0;
  private failureWindow = Date.now();
  readonly cookieName: string;
  private readonly adminKey: string;

  constructor(adminKey: string, publicOrigin: string) {
    this.adminKey = adminKey;
    this.cookieName = `piws_session_${createHash("sha256").update(publicOrigin).digest("hex").slice(0, 12)}`;
  }

  private cookie(request: Pick<FastifyRequest, "headers">): string | undefined {
    return request.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1);
  }

  current(request: Pick<FastifyRequest, "headers">): { csrf: string; expires: number } | undefined {
    const token = this.cookie(request);
    const stored = token ? this.sessions.get(token) : undefined;
    if (stored && stored.expires > Date.now()) return stored;
    if (token) this.sessions.delete(token);
    return undefined;
  }

  register(app: FastifyInstance): void {
    app.get("/api/v1/session", async (request) => {
      const current = this.current(request);
      return current ? { authenticated: true, csrfToken: current.csrf } : { authenticated: false };
    });
    app.post("/api/v1/login", async (request, reply) => {
      if (Date.now() - this.failureWindow > 60_000) { this.failureWindow = Date.now(); this.failedLogins = 0; }
      for (const [token, stored] of this.sessions) if (stored.expires <= Date.now()) this.sessions.delete(token);
      if (this.failedLogins >= 5) return reply.code(429).send({ error: { code: "RATE_LIMITED" } });
      const key = (request.body as { key?: unknown } | undefined)?.key;
      if (typeof key !== "string" || !equalSecret(key, this.adminKey)) {
        this.failedLogins++;
        return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
      }
      this.failedLogins = 0;
      const oldToken = this.cookie(request);
      if (oldToken) this.sessions.delete(oldToken);
      const token = randomBytes(32).toString("base64url");
      const csrf = randomBytes(32).toString("base64url");
      this.sessions.set(token, { csrf, expires: Date.now() + 30 * 60_000 });
      reply.header("Set-Cookie", `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
      return { authenticated: true, csrfToken: csrf };
    });
    app.post("/api/v1/logout", async (request, reply) => {
      const token = this.cookie(request);
      if (token) this.sessions.delete(token);
      reply.header("Set-Cookie", `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return { authenticated: false };
    });
  }
}
