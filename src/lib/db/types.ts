export type Context = {
  tenantId?: string;
  userId?: string;
  membershipId?: string;
  sessionDigest?: string;
  ssoId?: string;
  rateDigest?: string;
  correlationId?: string;
};
export interface Sql {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Database {
  run<T>(
    role: "auth" | "runtime",
    ctx: Context,
    fn: (sql: Sql) => Promise<T>,
    options?: { isolation: "repeatable read" },
  ): Promise<T>;
}
