export class InternalServiceError extends Error {
  readonly service: string;
  readonly status: number;
  readonly code: string;
  constructor(service: string, status: number, code: string) {
    super(`${service}:${code}`);
    this.service = service; this.status = status; this.code = code;
  }
}

export class InternalClient {
  readonly name: string;
  readonly baseUrl: string;
  private readonly serviceKey: string;
  constructor(name: string, baseUrl: string, serviceKey: string) {
    this.name = name; this.baseUrl = baseUrl; this.serviceKey = serviceKey;
  }

  async request<T>(method: string, path: string, body?: unknown, timeout = 10_000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: { Authorization: `Bearer ${this.serviceKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new InternalServiceError(this.name, 503, "UNAVAILABLE"); }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new InternalServiceError(this.name, 502, "INVALID_RESPONSE"); }
    if (!response.ok) {
      const code = (data as { error?: { code?: unknown } })?.error?.code;
      throw new InternalServiceError(this.name, response.status, typeof code === "string" ? code : "REQUEST_FAILED");
    }
    return data as T;
  }
}
