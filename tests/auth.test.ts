import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { TestDatabase } from "./helpers/database";
import { SessionRepository } from "../src/lib/session/repository";
import {
  AuthService,
  tokenDigest,
  type IdentityProvider,
} from "../src/lib/session/service";
import { SsoError } from "../src/lib/sso/client";
import type { VerifiedIdentity, UserStatus } from "../src/lib/sso/schemas";
import { AppError } from "../src/lib/security/errors";
import { AuthController } from "../src/features/auth/controller";
import * as H from "../src/lib/security/http";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002",
  UA = "00000000-0000-4000-8000-000000000011";
const db = new TestDatabase();
let repo: SessionRepository,
  service: AuthService,
  provider: Provider,
  clock: Date;
class Provider implements IdentityProvider {
  logins = 0;
  checks = 0;
  id = "test_admin_a";
  version = 1;
  active = true;
  outage = false;
  missing = false;
  async authenticate(
    username: string,
    password: string,
  ): Promise<VerifiedIdentity> {
    this.logins++;
    if (!this.active || password !== "  valid 😀  ")
      throw new SsoError("INVALID_CREDENTIALS", 401, "client", "gateway");
    return {
      sso_user_id: this.id,
      username,
      full_name: "Nama Pusat Terbaru",
      account_status: "active",
      identity_version: this.version,
      authenticated_at: new Date().toISOString(),
      request_id: "test-request",
    };
  }
  async getUserStatus(id: string): Promise<UserStatus> {
    this.checks++;
    if (this.outage)
      throw new SsoError("SERVICE_UNAVAILABLE", 503, "client", "gateway");
    if (this.missing) throw new SsoError("NOT_FOUND", 404, "client", "gateway");
    return {
      sso_user_id: id,
      account_status: this.active ? "active" : "suspended",
      is_archived: false,
      can_authenticate: this.active,
      identity_version: this.version,
      checked_at: new Date().toISOString(),
      request_id: "status-request",
    };
  }
}
const valid = { username: "TEST.ADMIN.A", password: "  valid 😀  " };
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e: unknown) => e instanceof AppError && e.code === code);
before(async () => {
  await db.init();
  repo = new SessionRepository(db);
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.pg.exec(
    `RESET ROLE; DELETE FROM inventory.app_sessions; DELETE FROM inventory.login_rate_limits; DELETE FROM inventory.sso_status_cache; DELETE FROM inventory.auth_events WHERE false;`,
  );
  provider = new Provider();
  clock = new Date();
  service = new AuthService(
    repo,
    provider,
    "test-rate-secret-public-not-production",
    () => clock,
  );
});
test("Verified login creates one server-side digest and selects the only active tenant", async () => {
  const r = await service.login(valid);
  assert.equal(r.next, "/dashboard");
  const q = await db.pg.query<{
    token_digest: string;
    active_tenant_id: string;
  }>("SELECT token_digest,active_tenant_id FROM inventory.app_sessions");
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].token_digest, tokenDigest(r.token));
  assert.notEqual(q.rows[0].token_digest, r.token);
  assert.equal(q.rows[0].active_tenant_id, A);
  const x = await service.session(r.token, { permission: "dashboard.view" });
  assert.equal(x.user.full_name_snapshot, "Nama Pusat Terbaru");
  assert.equal(provider.checks, 0);
});
test("Incorrect password and centrally inactive account do not create sessions", async () => {
  await rejects(
    () => service.login({ ...valid, password: "wrong" }),
    "INVALID_CREDENTIALS",
  );
  provider.active = false;
  await rejects(() => service.login(valid), "INVALID_CREDENTIALS");
  assert.equal(
    (await db.pg.query("SELECT id FROM inventory.app_sessions")).rows.length,
    0,
  );
});
test("Valid central identity without local user/membership is denied without provisioning", async () => {
  provider.id = "unregistered_user";
  await rejects(() => service.login(valid), "LOCAL_ACCESS_DENIED");
  assert.equal(
    (await db.pg.query("SELECT id FROM inventory.app_users")).rows.length,
    3,
  );
  assert.equal(
    (await db.pg.query("SELECT id FROM inventory.app_sessions")).rows.length,
    0,
  );
});
test("Logout revokes the digest and login again issues a fresh token", async () => {
  const first = await service.login(valid);
  await service.logout(first.token);
  await rejects(() => service.session(first.token), "SESSION_INVALID");
  const second = await service.login(valid, first.token);
  assert.notEqual(first.token, second.token);
  assert.equal(provider.logins, 2);
  assert.equal(
    (await service.session(second.token)).session.active_tenant_id,
    A,
  );
});
test("A new login on the same browser revokes its prior token", async () => {
  const first = await service.login(valid);
  const second = await service.login(valid, first.token);
  await rejects(() => service.session(first.token), "SESSION_INVALID");
  assert.ok(await service.session(second.token));
});
test("Absolute and idle expiration reject sessions", async () => {
  const a = await service.login(valid);
  clock = new Date(clock.getTime() + 31 * 60000);
  await rejects(() => service.session(a.token), "SESSION_INVALID");
  clock = new Date();
  const b = await service.login(valid);
  clock = new Date(clock.getTime() + 8 * 3600000 + 1);
  await rejects(() => service.session(b.token), "SESSION_INVALID");
});
test("Identity version change revokes every local session for that user", async () => {
  const a = await service.login(valid),
    b = await service.login(valid);
  provider.version = 2;
  clock = new Date(clock.getTime() + 61000);
  await rejects(() => service.session(a.token), "SESSION_INVALID");
  await rejects(() => service.session(b.token), "SESSION_INVALID");
  const count = (
    await db.pg.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM inventory.app_sessions WHERE revoked_at IS NULL",
    )
  ).rows[0].n;
  assert.equal(count, "0");
});
test("Status outage fails closed without extending freshness or destroying the session", async () => {
  const a = await service.login(valid);
  const before = (await repo.cache(UA))!.checked_at;
  provider.outage = true;
  clock = new Date(clock.getTime() + 61000);
  await rejects(() => service.session(a.token), "SERVICE_UNAVAILABLE");
  const x = await repo.load(tokenDigest(a.token));
  assert.equal(x!.session.revoked_at, null);
  assert.equal(
    new Date((await repo.cache(UA))!.checked_at).getTime(),
    new Date(before).getTime(),
  );
  provider.outage = false;
  assert.ok(await service.session(a.token));
  assert.equal(provider.checks, 2);
});
test("Central suspension and missing account revoke a local session", async () => {
  const a = await service.login(valid);
  provider.active = false;
  clock = new Date(clock.getTime() + 61000);
  await rejects(() => service.session(a.token), "SESSION_INVALID");
  provider.active = true;
  const b = await service.login(valid);
  provider.missing = true;
  clock = new Date(clock.getTime() + 61000);
  await rejects(() => service.session(b.token), "SESSION_INVALID");
});
test("Sensitive operation always checks central status despite a fresh cache", async () => {
  const a = await service.login(valid);
  assert.equal(provider.checks, 0);
  await service.session(a.token, { sensitive: true });
  assert.equal(provider.checks, 1);
});
test("Membership revocation invalidates a session immediately", async () => {
  provider.id = "test_viewer";
  const a = await service.login({ ...valid, username: "test.viewer" });
  await db.pg.exec(
    `UPDATE inventory.tenant_memberships SET status='inactive' WHERE id='00000000-0000-4000-8000-000000000023'`,
  );
  try {
    await rejects(() => service.session(a.token), "SESSION_INVALID");
  } finally {
    await db.pg.exec(
      `UPDATE inventory.tenant_memberships SET status='active' WHERE id='00000000-0000-4000-8000-000000000023'`,
    );
  }
});
test("Multiple memberships require tenant selection and switching rotates token without extending absolute expiry", async () => {
  const mid = "00000000-0000-4000-8000-000000000099";
  await db.pg.exec(
    `INSERT INTO inventory.tenant_memberships(id,tenant_id,app_user_id,role_id) SELECT '${mid}','${B}','${UA}',id FROM inventory.roles WHERE tenant_id='${B}' AND code='viewer'`,
  );
  try {
    const a = await service.login(valid);
    assert.equal(a.next, "/pilih-lembaga");
    const initial = await service.session(a.token, { tenant: false });
    await rejects(() => service.session(a.token), "TENANT_REQUIRED");
    const b = await service.switchTenant(a.token, B);
    assert.notEqual(a.token, b.token);
    await rejects(() => service.session(a.token), "SESSION_INVALID");
    const selected = await service.session(b.token);
    assert.equal(selected.session.active_tenant_id, B);
    assert.equal(
      new Date(selected.session.expires_at).getTime(),
      new Date(initial.session.expires_at).getTime(),
    );
    const permissions = await repo.permissions(selected);
    assert.ok(permissions.includes("assets.view"));
    assert.equal(permissions.includes("assets.create"), false);
  } finally {
    await db.pg.exec(
      `DELETE FROM inventory.app_sessions; DELETE FROM inventory.tenant_memberships WHERE id='${mid}'`,
    );
  }
});
test("Tampered tenant choice is rejected and preserves existing session", async () => {
  const a = await service.login(valid);
  await rejects(() => service.switchTenant(a.token, B), "TENANT_DENIED");
  assert.ok(await service.session(a.token));
  assert.equal(provider.checks, 1);
});
test("Shared PostgreSQL account limiter blocks before sixth SSO request", async () => {
  for (let i = 0; i < 5; i++)
    await rejects(
      () => service.login({ ...valid, password: "wrong" }),
      "INVALID_CREDENTIALS",
    );
  await rejects(() => service.login(valid), "RATE_LIMITED");
  assert.equal(provider.logins, 5);
});
test("Permission guard denies a permission absent from current role", async () => {
  provider.id = "test_viewer";
  const a = await service.login(valid);
  await rejects(
    () => service.session(a.token, { permission: "users.manage" }),
    "PERMISSION_DENIED",
  );
});
test("CSRF requires exact Origin and matching cookie/header; duplicate cookies fail closed", () => {
  const origin = "https://inventory.test.invalid",
    csrf = "a".repeat(64),
    name = H.cookieNames(origin).csrf;
  const req = (o: string, token: string, cookie = `${name}=${csrf}`) =>
    new Request(origin + "/api/auth/login", {
      method: "POST",
      headers: { Origin: o, "X-CSRF-Token": token, Cookie: cookie },
    });
  assert.doesNotThrow(() => H.assertCsrf(req(origin, csrf), origin));
  assert.throws(
    () => H.assertCsrf(req("https://evil.invalid", csrf), origin),
    AppError,
  );
  assert.throws(
    () => H.assertCsrf(req(origin, "b".repeat(64)), origin),
    AppError,
  );
  assert.throws(
    () =>
      H.assertCsrf(
        req(origin, csrf, `${name}=${csrf}; ${name}=${csrf}`),
        origin,
      ),
    AppError,
  );
});
test("Controller login/logout cookies are HttpOnly/Secure/Host-scoped and cannot disclose token in JSON", async () => {
  const origin = "https://inventory.test.invalid",
    controller = new AuthController(service, origin);
  const csrf = await controller.handle(
    "csrf",
    new Request(origin + "/api/auth/csrf"),
  );
  const c = await csrf.json();
  const csrfCookie = csrf.headers.get("set-cookie")!.split(";")[0];
  const req = (action: string, body: unknown, cookies = csrfCookie) =>
    new Request(origin + "/api/auth/" + action, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-CSRF-Token": c.token,
        "Content-Type": "application/json",
        Cookie: cookies,
      },
      body: JSON.stringify(body),
    });
  const login = await controller.handle("login", req("login", valid));
  assert.equal(login.status, 200);
  const sc = login.headers.get("set-cookie")!;
  assert.match(sc, /^__Host-inventaris_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.ok(!sc.includes("Domain="));
  assert.deepEqual(await login.json(), { success: true, next: "/dashboard" });
  const logout = await controller.handle(
    "logout",
    req("logout", {}, csrfCookie + "; " + sc.split(";")[0]),
  );
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(logout.headers.get("cache-control"), "private, no-store");
});
test("Controller rejects Origin/CSRF, extra credential fields and oversized JSON", async () => {
  const origin = "https://inventory.test.invalid",
    controller = new AuthController(service, origin);
  assert.equal(
    (
      await controller.handle(
        "login",
        new Request(origin + "/api/auth/login", { method: "POST" }),
      )
    ).status,
    403,
  );
  const csrf = "a".repeat(64),
    headers = {
      Origin: origin,
      "X-CSRF-Token": csrf,
      Cookie: `${H.cookieNames(origin).csrf}=${csrf}`,
      "Content-Type": "application/json",
    };
  assert.equal(
    (
      await controller.handle(
        "login",
        new Request(origin + "/api/auth/login", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...valid, tenant_id: A }),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await controller.handle(
        "login",
        new Request(origin + "/api/auth/login", {
          method: "POST",
          headers,
          body: "x".repeat(13000),
        }),
      )
    ).status,
    413,
  );
});
test("Controller → HMAC adapter → test gateway → PostgreSQL → logout → relogin", async () => {
  const { SsoClient } = await import("../src/lib/sso/client");
  const { createHmac } = await import("node:crypto");
  const secret = "abcdef0123456789".repeat(4);
  const nonces = new Set<string>();
  let signedCalls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const e = JSON.parse(String(init?.body)),
      frame = JSON.stringify([
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
    assert.equal(
      e.signature,
      createHmac("sha256", secret).update(frame).digest("hex"),
    );
    assert.equal(nonces.has(e.nonce), false);
    nonces.add(e.nonce);
    signedCalls++;
    const payload = JSON.parse(Buffer.from(e.payload, "base64url").toString());
    assert.equal(payload.password, valid.password);
    const now = new Date().toISOString();
    return Response.json({
      success: true,
      data: {
        sso_user_id: "test_admin_a",
        username: "test.admin.a",
        full_name: "Gateway Uji",
        account_status: "active",
        identity_version: 1,
        authenticated_at: now,
        request_id: e.request_id,
      },
      request_id: e.request_id,
      timestamp: now,
    });
  };
  const actual = new AuthService(
    repo,
    new SsoClient(
      {
        baseUrl: "https://sso.test.invalid",
        applicationId: "app_test",
        keyId: "key_test",
        clientSecret: secret,
      },
      fetcher,
    ),
    "test-rate-secret-public-not-production",
  );
  const origin = "https://inventory.test.invalid",
    controller = new AuthController(actual, origin),
    csrf = "c".repeat(64),
    csrfCookie = `${H.cookieNames(origin).csrf}=${csrf}`;
  const request = (action: string, body: unknown, cookies = csrfCookie) =>
    new Request(origin + "/api/auth/" + action, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        Cookie: cookies,
      },
      body: JSON.stringify(body),
    });
  const a = await controller.handle("login", request("login", valid));
  assert.equal(a.status, 200);
  const cookieA = a.headers.get("set-cookie")!.split(";")[0];
  const out = await controller.handle(
    "logout",
    request("logout", {}, csrfCookie + "; " + cookieA),
  );
  assert.equal(out.status, 200);
  const b = await controller.handle("login", request("login", valid));
  assert.equal(b.status, 200);
  const cookieB = b.headers.get("set-cookie")!.split(";")[0];
  assert.notEqual(cookieA, cookieB);
  assert.equal(signedCalls, 2);
  const rows = await db.pg.query<{ revoked_at: Date | null }>(
    "SELECT revoked_at FROM inventory.app_sessions",
  );
  assert.equal(rows.rows.filter((x) => x.revoked_at === null).length, 1);
});
test("Application login budget leaves margin below the documented central default and commits rejected attempts", async () => {
  const { createHmac } = await import("node:crypto");
  const key = createHmac("sha256", "test-rate-secret-public-not-production")
    .update("global")
    .digest("hex");
  await db.pg.query(
    "INSERT INTO inventory.login_rate_limits(key_digest,window_started_at,attempts) VALUES($1,clock_timestamp(),90)",
    [key],
  );
  await rejects(() => service.login(valid), "RATE_LIMITED");
  assert.equal(provider.logins, 0);
  const row = (
    await db.pg.query<{ attempts: number }>(
      "SELECT attempts FROM inventory.login_rate_limits WHERE key_digest=$1",
      [key],
    )
  ).rows[0];
  assert.equal(row.attempts, 91);
});
test("Locally inactive user cannot receive a session despite verified central credentials", async () => {
  await db.pg.query(
    "UPDATE inventory.app_users SET status='inactive' WHERE id=$1",
    [UA],
  );
  try {
    await rejects(() => service.login(valid), "LOCAL_ACCESS_DENIED");
    assert.equal(
      (await db.pg.query("SELECT id FROM inventory.app_sessions")).rows.length,
      0,
    );
  } finally {
    await db.pg.query(
      "UPDATE inventory.app_users SET status='active' WHERE id=$1",
      [UA],
    );
  }
});
