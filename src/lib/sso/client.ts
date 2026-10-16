import "server-only";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import * as S from "./schemas";
export class SsoError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    public clientRequestId: string,
    public responseRequestId?: string,
  ) {
    super(code);
    this.name = "SsoError";
  }
}
export type SsoConfig = {
  baseUrl: string;
  applicationId: string;
  keyId: string;
  clientSecret: string;
  timeoutMs?: number;
};
export function envelope(
  config: SsoConfig,
  op: string,
  payload: object,
  meta?: { requestId: string; timestamp: string; nonce: string },
) {
  const e = {
    v: "1",
    aud: "central-sso-app",
    op,
    application_id: config.applicationId,
    key_id: config.keyId,
    request_id: meta?.requestId ?? randomUUID(),
    timestamp: meta?.timestamp ?? Date.now().toString(),
    nonce: meta?.nonce ?? randomBytes(32).toString("hex"),
    payload: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  };
  const frame = JSON.stringify([
    e.v,
    e.aud,
    e.op,
    e.application_id,
    e.key_id,
    e.request_id,
    e.timestamp,
    e.nonce,
    e.payload,
  ]);
  return {
    ...e,
    signature: createHmac("sha256", config.clientSecret)
      .update(frame, "utf8")
      .digest("hex"),
  };
}
async function boundedText(r: Response, limit = 131072) {
  if (Number(r.headers.get("content-length")) > limit)
    throw new Error("response_too_large");
  const reader = r.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const x = await reader.read();
      if (x.done) break;
      n += x.value.byteLength;
      if (n > limit) throw new Error("response_too_large");
      chunks.push(x.value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
const errors: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  INVALID_CLIENT: 401,
  INVALID_SIGNATURE: 401,
  REQUEST_EXPIRED: 401,
  INVALID_CHALLENGE: 401,
  PERMISSION_DENIED: 403,
  APPLICATION_INACTIVE: 403,
  NOT_FOUND: 404,
  REPLAY_DETECTED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};
export class SsoClient {
  constructor(
    private cfg: SsoConfig,
    private fetcher: typeof fetch = fetch,
  ) {
    const u = new URL(cfg.baseUrl);
    if (
      u.protocol !== "https:" ||
      u.origin !== cfg.baseUrl ||
      u.username ||
      u.password ||
      !/^[0-9a-f]{64}$/.test(cfg.clientSecret) ||
      !/^[a-zA-Z0-9_.:-]{1,160}$/.test(cfg.applicationId) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(cfg.keyId)
    )
      throw new Error("Invalid SSO configuration");
  }
  private async call<T extends z.ZodType>(
    path: string,
    op: string,
    payload: object,
    schema: T,
  ): Promise<z.infer<T>> {
    const e = envelope(this.cfg, op, payload);
    const body = JSON.stringify(e);
    if (Buffer.byteLength(body) > 12288)
      throw new SsoError("PAYLOAD_TOO_LARGE", 413, e.request_id);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 45000);
    try {
      const r = await this.fetcher(this.cfg.baseUrl + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (
        r.redirected ||
        (r.status >= 300 && r.status < 400) ||
        !/^application\/json(?:;|$)/i.test(r.headers.get("content-type") ?? "")
      )
        throw new Error("invalid_transport");
      const raw: unknown = JSON.parse(await boundedText(r));
      if (r.status !== 200) {
        const err = S.errorResponse.safeParse(raw);
        if (!err.success || errors[err.data.error.code] !== r.status)
          throw new Error("invalid_error");
        const code = err.data.error.code;
        if (
          ((code === "INVALID_CREDENTIALS" || code === "INVALID_CHALLENGE") &&
            op !== "authenticate.user") ||
          (code === "NOT_FOUND" && op === "authenticate.user")
        )
          throw new Error("invalid_operation_error");
        throw new SsoError(code, r.status, e.request_id, err.data.request_id);
      }
      const parsed = S.response(schema).safeParse(raw);
      if (!parsed.success) throw new Error("invalid_response");
      const wrapper = parsed.data as unknown as {
        request_id: string;
        data: z.infer<T>;
      };
      if (
        wrapper.request_id !== e.request_id ||
        (wrapper.data as { request_id?: string }).request_id !== e.request_id
      )
        throw new Error("invalid_response");
      return wrapper.data;
    } catch (err) {
      if (err instanceof SsoError) throw err;
      throw new SsoError("SSO_TRANSPORT_ERROR", 503, e.request_id);
    } finally {
      clearTimeout(timer);
    }
  }
  authenticate(username: string, password: string) {
    const input = S.loginInput.parse({ username, password });
    return this.call(
      "/api/v1/auth/verify",
      "authenticate.user",
      input,
      S.authData,
    );
  }
  async getUserStatus(userId: string) {
    S.opaque.parse(userId);
    const data = await this.call(
      "/api/v1/users/status",
      "user.status",
      { user_id: userId },
      S.statusData,
    );
    if (data.sso_user_id !== userId)
      throw new SsoError("SSO_ID_MISMATCH", 503, data.request_id);
    return data;
  }
  searchUsers(input: S.SearchInput) {
    return this.call(
      "/api/v1/directory/search",
      "directory.search",
      S.searchInput.parse(input),
      S.searchData,
    );
  }
  async getUser(userId: string) {
    S.opaque.parse(userId);
    const data = await this.call(
      "/api/v1/directory/get",
      "directory.get",
      { user_id: userId },
      S.getData,
    );
    if (data.user.sso_user_id !== userId)
      throw new SsoError("SSO_ID_MISMATCH", 503, data.request_id);
    return data.user;
  }
}
