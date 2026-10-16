import { z } from "zod";
import { opaque } from "@/lib/sso/schemas";
export const roleCode = z.enum(["admin", "petugas", "viewer"]);
export const memberCreate = z
  .object({
    sso_user_id: opaque,
    role: roleCode,
    status: z.enum(["active", "inactive"]),
  })
  .strict();
export const memberUpdate = z
  .object({
    membership_id: z.uuid(),
    role: roleCode,
    status: z.enum(["active", "inactive", "revoked"]),
    row_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const roleUpdate = z
  .object({
    role_id: z.uuid(),
    permissions: z
      .array(z.string().min(1).max(100))
      .max(100)
      .refine((a) => new Set(a).size === a.length),
    row_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const profileInput = z
  .object({
    name: z.string().trim().min(1).max(300),
    timezone: z.enum(["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"]),
    row_version: z.number().int().min(1),
    profile: z
      .object({
        npsn: z.string().max(30),
        nsm: z.string().max(30),
        address: z.string().max(1500),
        phone: z.string().max(50),
        email: z.union([z.email(), z.literal("")]),
        principal_name: z.string().max(200),
      })
      .strict(),
  })
  .strict();
export const provisionInput = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,40}$/),
    name: z.string().trim().min(1).max(300),
    admin_sso_user_id: opaque,
    idempotency_key: z.uuid(),
  })
  .strict();
export const tenantStatusInput = z
  .object({
    tenant_id: z.uuid(),
    status: z.enum(["active", "inactive"]),
    row_version: z.number().int().min(1),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type Member = {
  id: string;
  role_id: string;
  app_user_id: string;
  sso_user_id: string;
  username: string;
  full_name: string;
  role_code: z.infer<typeof roleCode>;
  status: "active" | "inactive" | "revoked";
  row_version: number;
};
export type Role = {
  id: string;
  code: z.infer<typeof roleCode>;
  name: string;
  permissions: string[];
  row_version: number;
};
export type Tenant = {
  id: string;
  code: string;
  name: string;
  status: string;
  timezone: string;
  row_version: number;
  profile: Partial<z.infer<typeof profileInput>["profile"]>;
};
export type AdminData = {
  items: Member[];
  roles: Role[];
  total: number;
  page: number;
  page_size: number;
  actor_id: string;
  tenant: Tenant;
  permission_catalog: { code: string; description: string }[];
  history: {
    action: string;
    resource_id: string;
    created_at: string;
    actor_id: string;
    details: Record<string, unknown>;
  }[];
};
export type PlatformData = {
  items: Pick<Tenant, "id" | "code" | "name" | "status" | "row_version">[];
  total: number;
  page: number;
  page_size: number;
};
