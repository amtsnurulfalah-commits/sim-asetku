import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import type { Database, Context, Sql } from "../../src/lib/db/types";
export class TestDatabase implements Database {
  readonly pg = new PGlite();
  private pending: Promise<unknown> = Promise.resolve();
  async init() {
    for (const name of fs
      .readdirSync(path.resolve("supabase/migrations"))
      .sort())
      await this.pg.exec(
        fs.readFileSync(path.resolve("supabase/migrations", name), "utf8"),
      );
    await this.pg.exec(
      fs.readFileSync(path.resolve("tests/fixtures.sql"), "utf8"),
    );
  }
  run<T>(
    role: "auth" | "runtime",
    ctx: Context,
    fn: (q: Sql) => Promise<T>,
    options?: { isolation: "repeatable read" },
  ): Promise<T> {
    const task = async () => {
      await this.pg.exec((options?.isolation === "repeatable read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ;" : "BEGIN;") + " SET LOCAL ROLE inventory_" + role);
      try {
        const keys: Record<keyof Context, string> = {
          tenantId: "app.tenant_id",
          userId: "app.user_id",
          membershipId: "app.membership_id",
          sessionDigest: "app.session_digest",
          ssoId: "app.sso_user_id",
          rateDigest: "app.rate_limit_digest",
          correlationId: "app.correlation_id",
        };
        for (const key of Object.keys(keys) as (keyof Context)[])
          await this.pg.query("SELECT set_config($1,$2,true)", [
            keys[key],
            ctx[key] ?? "",
          ]);
        const sql: Sql = {
          query: async <R>(text: string, params: unknown[] = []) => {
            const x = await this.pg.query(text, params);
            return { rows: x.rows as R[], rowCount: x.affectedRows ?? 0 };
          },
        };
        const result = await fn(sql);
        await this.pg.exec("COMMIT");
        return result;
      } catch (e) {
        await this.pg.exec("ROLLBACK");
        throw e;
      }
    };
    const result = this.pending.then(task, task);
    this.pending = result.catch(() => {});
    return result;
  }
  async close() {
    await this.pending;
    await this.pg.close();
  }
}
