/** Administrative bootstrap only. Requires MIGRATION_DATABASE_URL and explicit username.
 * Never imported by the application. No central account/password is created here.
 */
import { Pool } from "pg";
import { config } from "../src/lib/config";
import { SsoClient } from "../src/lib/sso/client";
const username = process.argv
  .find((x) => x.startsWith("--username="))
  ?.slice(11)
  .trim()
  .toLowerCase();
const days = Number(
  process.argv.find((x) => x.startsWith("--days="))?.slice(7) ?? 30,
);
if (
  !username ||
  !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) ||
  !Number.isSafeInteger(days) ||
  days < 1 ||
  days > 90
)
  throw new Error("Use --username=exact.username and optional --days=1..90");
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error(
    "MIGRATION_DATABASE_URL is required for the authorized database operator",
  );
const c = config(),
  sso = new SsoClient({
    baseUrl: c.CENTRAL_SSO_API_URL,
    applicationId: c.CENTRAL_SSO_APPLICATION_ID,
    keyId: c.CENTRAL_SSO_KEY_ID,
    clientSecret: c.CENTRAL_SSO_CLIENT_SECRET,
  });
const found = await sso.searchUsers({
  query: username,
  status: "active",
  page: 1,
  page_size: 25,
  sort_by: "username",
  sort_direction: "asc",
});
const exact = found.items.filter((u) => u.username === username);
if (exact.length !== 1)
  throw new Error(
    "No unambiguous exact active username in returned directory page; no grant written",
  );
const user = await sso.getUser(exact[0].sso_user_id);
if (user.account_status !== "active")
  throw new Error("Central account must be active");
let url: URL;
try {
  url = new URL(process.env.MIGRATION_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
} catch {
  throw new Error("Invalid migration database URL; no credentials are printed");
}
for (const k of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
  url.searchParams.delete(k);
if (
  c.DATABASE_TLS_MODE === "disable" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
)
  throw new Error("TLS may only be disabled for localhost development");
const pool = new Pool({
  connectionString: url.toString(),
  max: 1,
  ssl:
    c.DATABASE_TLS_MODE === "disable"
      ? false
      : {
          rejectUnauthorized: true,
          ...(c.DATABASE_CA_CERT ? { ca: c.DATABASE_CA_CERT } : {}),
        },
});
const connection = await pool.connect();
try {
  await connection.query("BEGIN");
  await connection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('bootstrap-platform-operator',0))",
  );
  const u = (
    await connection.query(
      `INSERT INTO inventory.app_users(sso_user_id,username_snapshot,full_name_snapshot) VALUES($1,$2,$3) ON CONFLICT(sso_user_id) DO UPDATE SET username_snapshot=EXCLUDED.username_snapshot,full_name_snapshot=EXCLUDED.full_name_snapshot RETURNING id,status`,
      [user.sso_user_id, user.username, user.full_name],
    )
  ).rows[0];
  if (u.status !== "active")
    throw new Error("Local account inactive; no grant written");
  await connection.query(
    `INSERT INTO inventory.platform_operator_grants(app_user_id,can_provision,expires_at,granted_reason) SELECT $1,true,clock_timestamp()+make_interval(days=>$2),'Authorized database operator bootstrap' WHERE NOT EXISTS(SELECT FROM inventory.platform_operator_grants WHERE app_user_id=$1 AND can_provision AND expires_at>clock_timestamp())`,
    [u.id, days],
  );
  await connection.query("COMMIT");
  console.log(
    "Operator bootstrap completed or active grant already existed. No tenant membership granted.",
  );
} catch {
  await connection.query("ROLLBACK");
  throw new Error(
    "Operator bootstrap transaction failed; inspect target permissions and account status securely.",
  );
} finally {
  connection.release();
  await pool.end();
}
