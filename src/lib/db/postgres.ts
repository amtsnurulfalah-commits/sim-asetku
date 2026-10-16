import "server-only";
import { Pool } from "pg";
import { config } from "../config";
import type { Context, Database, Sql } from "./types";
export class PostgresDatabase implements Database {
  private pools?: { auth: Pool; runtime: Pool };
  private pool(role: "auth" | "runtime") {
    if (!this.pools) {
      const c = config();
      const settings = {
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
        query_timeout: 12000,
      };
      const connection = (raw: string) => {
        const u = new URL(raw);
        for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
          u.searchParams.delete(name);
        return {
          ...settings,
          connectionString: u.toString(),
          ssl:
            c.DATABASE_TLS_MODE === "disable"
              ? false
              : {
                  rejectUnauthorized: true,
                  ...(c.DATABASE_CA_CERT ? { ca: c.DATABASE_CA_CERT } : {}),
                },
        };
      };
      this.pools = {
        auth: new Pool(connection(c.AUTH_DATABASE_URL)),
        runtime: new Pool(connection(c.DATABASE_URL)),
      };
      for (const p of Object.values(this.pools))
        p.on("error", () => {
          console.error("DATABASE_POOL_ERROR");
        });
    }
    return this.pools[role];
  }
  async run<T>(
    role: "auth" | "runtime",
    ctx: Context,
    fn: (sql: Sql) => Promise<T>,
    options?: { isolation: "repeatable read" },
  ) {
    const conn = await this.pool(role).connect();
    try {
      await conn.query(options?.isolation === "repeatable read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN");
      await conn.query(
        role === "auth"
          ? "SET LOCAL ROLE inventory_auth"
          : "SET LOCAL ROLE inventory_runtime",
      );
      const names: Record<keyof Context, string> = {
        tenantId: "app.tenant_id",
        userId: "app.user_id",
        membershipId: "app.membership_id",
        sessionDigest: "app.session_digest",
        ssoId: "app.sso_user_id",
        rateDigest: "app.rate_limit_digest",
        correlationId: "app.correlation_id",
      };
      // Always clear all contexts within the transaction, including absent values.
      for (const k of Object.keys(names) as (keyof Context)[])
        await conn.query("SELECT set_config($1,$2,true)", [
          names[k],
          ctx[k] ?? "",
        ]);
      const sql: Sql = {
        async query<R>(text: string, params: unknown[] = []) {
          const r = await conn.query(text, params);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
      };
      const result = await fn(sql);
      await conn.query("COMMIT");
      return result;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }
}
