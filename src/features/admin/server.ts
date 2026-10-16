import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/features/auth/server";
import { config } from "@/lib/config";
import { SsoClient } from "@/lib/sso/client";
import { cookieNames, json } from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
import { AdminService, mapAdminError } from "./service";
import { AdminController, type AdminAction } from "./controller";
import type { AdminData, PlatformData } from "./schemas";
export function admin() {
  const c = config();
  return new AdminService(
    auth(),
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
export async function adminDispatch(action: AdminAction, r: Request) {
  try {
    return await new AdminController(admin(), config().APP_BASE_URL).handle(
      action,
      r,
    );
  } catch (e) {
    const x = mapAdminError(e);
    return json(
      { success: false, error: { code: x.code, message: x.publicMessage } },
      x.status,
    );
  }
}
export function adminPage(platform: true): Promise<PlatformData>;
export function adminPage(platform?: false): Promise<AdminData>;
export async function adminPage(platform = false) {
  try {
    const c = config(),
      token = (await cookies()).get(cookieNames(c.APP_BASE_URL).session)?.value;
    return platform
      ? await admin().platformData(token)
      : await admin().data(token);
  } catch (e) {
    const err = mapAdminError(e);
    if (err.status === 401) redirect("/login");
    if (err.code === "TENANT_REQUIRED") redirect("/pilih-lembaga");
    if (err.status === 403) redirect("/akses-ditolak");
    throw new AppError(err.code, err.status, err.publicMessage);
  }
}
