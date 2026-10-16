import "server-only";
import { isIP } from "node:net";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { PostgresDatabase } from "@/lib/db/postgres";
import { SsoClient } from "@/lib/sso/client";
import { SessionRepository } from "@/lib/session/repository";
import { AuthService } from "@/lib/session/service";
import { cookieNames, json } from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
import { AuthController } from "./controller";
let instance: AuthService | undefined;
export function auth() {
  if (!instance) {
    const c = config();
    instance = new AuthService(
      new SessionRepository(new PostgresDatabase()),
      new SsoClient({
        baseUrl: c.CENTRAL_SSO_API_URL,
        applicationId: c.CENTRAL_SSO_APPLICATION_ID,
        keyId: c.CENTRAL_SSO_KEY_ID,
        clientSecret: c.CENTRAL_SSO_CLIENT_SECRET,
        timeoutMs: c.CENTRAL_SSO_TIMEOUT_MS,
      }),
      c.RATE_LIMIT_SECRET,
    );
  }
  return instance;
}
export async function dispatch(
  action: Parameters<AuthController["handle"]>[0],
  request: Request,
) {
  try {
    const c = config();
    const trustedSource = (r: Request) => {
      if (process.env.VERCEL !== "1") return undefined;
      const ip = r.headers.get("x-vercel-forwarded-for")?.trim();
      return ip && isIP(ip) ? ip : undefined;
    };
    return await new AuthController(
      auth(),
      c.APP_BASE_URL,
      trustedSource,
    ).handle(action, request);
  } catch (e) {
    const error =
      e instanceof AppError
        ? e
        : new AppError(
            "SERVICE_UNAVAILABLE",
            503,
            "Layanan belum tersedia. Hubungi administrator.",
          );
    return json(
      {
        success: false,
        error: { code: error.code, message: error.publicMessage },
      },
      error.status,
    );
  }
}
export async function pageSession(tenant = true, permission?: string) {
  const c = config();
  const token = (await cookies()).get(
    cookieNames(c.APP_BASE_URL).session,
  )?.value;
  try {
    return await auth().session(token, { tenant, permission });
  } catch (e) {
    if (e instanceof AppError) {
      if (e.status === 401) redirect("/login");
      if (e.code === "TENANT_REQUIRED") redirect("/pilih-lembaga");
      if (e.status === 403) redirect("/akses-ditolak");
      throw e;
    }
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      503,
      "Layanan belum dapat dihubungi.",
    );
  }
}
