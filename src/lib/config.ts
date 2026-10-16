import "server-only";
import { z } from "zod";
import { AppError } from "./security/errors";
const origin = z
  .string()
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.origin === v && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Gunakan origin tanpa path atau slash akhir");
const databaseUrl = z
  .string()
  .url()
  .refine((v) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  });
const schema = z.object({
  APP_BASE_URL: origin,
  CENTRAL_SSO_API_URL: origin.refine((v) => v.startsWith("https://")),
  CENTRAL_SSO_APPLICATION_ID: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/),
  CENTRAL_SSO_KEY_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  CENTRAL_SSO_CLIENT_SECRET: z.string().regex(/^[0-9a-f]{64}$/),
  AUTH_DATABASE_URL: databaseUrl,
  DATABASE_URL: databaseUrl,
  DATABASE_TLS_MODE: z.enum(["verify-full", "disable"]).default("verify-full"),
  DATABASE_CA_CERT: z.string().optional(),
  RATE_LIMIT_SECRET: z.string().min(32),
  CENTRAL_SSO_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(45000),
});
export function config() {
  const r = schema.safeParse(process.env);
  if (!r.success)
    throw new AppError(
      "CONFIGURATION_ERROR",
      503,
      "Konfigurasi layanan belum lengkap. Hubungi administrator.",
    );
  const c = r.data;
  if (
    process.env.NODE_ENV === "production" &&
    !c.APP_BASE_URL.startsWith("https://")
  )
    throw new AppError(
      "CONFIGURATION_ERROR",
      503,
      "Konfigurasi HTTPS belum sesuai.",
    );
  if (
    c.DATABASE_TLS_MODE === "disable" &&
    (process.env.NODE_ENV === "production" ||
      ![c.AUTH_DATABASE_URL, c.DATABASE_URL].every((v) =>
        ["localhost", "127.0.0.1", "[::1]"].includes(new URL(v).hostname),
      ))
  )
    throw new AppError(
      "CONFIGURATION_ERROR",
      503,
      "Konfigurasi TLS database belum sesuai.",
    );
  return c;
}
