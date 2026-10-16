import { z } from "zod";
export const opaque = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
const time = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
const account = z.enum(["active", "inactive", "suspended"]);
export const identity = z
  .object({
    sso_user_id: opaque,
    username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
    full_name: z.string().min(1).max(40000),
    account_status: account,
    identity_version: z.number().int().min(1),
  })
  .strict();
export const loginInput = z
  .object({
    username: z
      .string()
      .transform((v) => v.trim().toLowerCase())
      .pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)),
    password: z
      .string()
      .refine(
        (v) =>
          [...v].length >= 1 &&
          [...v].length <= 1024 &&
          Buffer.byteLength(v, "utf8") <= 4096,
      ),
  })
  .strict();
export const searchInput = z
  .object({
    query: z
      .string()
      .refine((v) => [...v].length <= 100 && !/[\u0000-\u001f\u007f]/.test(v))
      .optional(),
    status: z.enum(["active", "inactive", "suspended", "all"]).optional(),
    page: z.number().int().min(1).max(1000000).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
    sort_by: z.enum(["username", "full_name", "sso_user_id"]).optional(),
    sort_direction: z.enum(["asc", "desc"]).optional(),
  })
  .strict();
export const authData = identity
  .extend({
    account_status: z.literal("active"),
    authenticated_at: time,
    request_id: opaque,
  })
  .strict();
export const statusData = z
  .object({
    sso_user_id: opaque,
    account_status: account,
    is_archived: z.boolean(),
    can_authenticate: z.boolean(),
    identity_version: z.number().int().min(1),
    checked_at: time,
    request_id: opaque,
  })
  .strict()
  .refine(
    (v) =>
      v.can_authenticate === (v.account_status === "active" && !v.is_archived),
  );
const pagination = z
  .object({
    page: z.number().int().min(1).max(1000000),
    page_size: z.number().int().min(1).max(100),
    total: z.number().int().min(0).max(20000),
    total_pages: z.number().int().min(0),
    has_next: z.boolean(),
  })
  .strict();
export const searchData = z
  .object({
    items: z.array(identity).max(100),
    pagination,
    request_id: opaque,
    retrieved_at: time,
  })
  .strict();
export const getData = z
  .object({ user: identity, request_id: opaque, retrieved_at: time })
  .strict();
export const errorResponse = z
  .object({
    success: z.literal(false),
    error: z
      .object({
        code: z.enum([
          "INVALID_CREDENTIALS",
          "INVALID_CLIENT",
          "INVALID_SIGNATURE",
          "REQUEST_EXPIRED",
          "INVALID_CHALLENGE",
          "PERMISSION_DENIED",
          "APPLICATION_INACTIVE",
          "NOT_FOUND",
          "REPLAY_DETECTED",
          "RATE_LIMITED",
          "VALIDATION_ERROR",
          "PAYLOAD_TOO_LARGE",
          "SERVICE_UNAVAILABLE",
        ]),
        message: z.string(),
      })
      .strict(),
    request_id: opaque,
    timestamp: time,
  })
  .strict();
export const response = <T extends z.ZodType>(data: T) =>
  z
    .object({
      success: z.literal(true),
      data,
      request_id: opaque,
      timestamp: time,
    })
    .strict();
export type VerifiedIdentity = z.infer<typeof authData>;
export type UserStatus = z.infer<typeof statusData>;
export type SearchInput = z.infer<typeof searchInput>;
