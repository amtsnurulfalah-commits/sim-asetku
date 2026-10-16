import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TestDatabase } from "./helpers/database";
import { SessionRepository } from "../src/lib/session/repository";
import {
  AuthService,
  tokenDigest,
  type IdentityProvider,
} from "../src/lib/session/service";
import {
  AdminService,
  mapAdminError,
  type DirectoryProvider,
} from "../src/features/admin/service";
import { AdminController } from "../src/features/admin/controller";
import type { VerifiedIdentity, UserStatus } from "../src/lib/sso/schemas";
import { cookieNames } from "../src/lib/security/http";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002",
  UA = "00000000-0000-4000-8000-000000000011",
  MA = "00000000-0000-4000-8000-000000000021",
  MB = "00000000-0000-4000-8000-000000000022";
const db = new TestDatabase();
let repo: SessionRepository,
  auth: AuthService,
  admin: AdminService,
  provider: Provider,
  token: string;
let searched = 0;
class Provider implements IdentityProvider, DirectoryProvider {
  id = "test_admin_a";
  async authenticate(username: string): Promise<VerifiedIdentity> {
    return {
      sso_user_id: this.id,
      username,
      full_name: "Admin Uji",
      account_status: "active",
      identity_version: 1,
      authenticated_at: new Date().toISOString(),
      request_id: "test-login",
    };
  }
  async getUserStatus(id: string): Promise<UserStatus> {
    return {
      sso_user_id: id,
      account_status: "active",
      is_archived: false,
      can_authenticate: true,
      identity_version: 1,
      checked_at: new Date().toISOString(),
      request_id: "test-status",
    };
  }
  async getUser(id: string) {
    return {
      sso_user_id: id,
      username: "new.member",
      full_name: "Pengguna Pusat",
      account_status:
        id === "inactive_user" ? ("inactive" as const) : ("active" as const),
      identity_version: 1,
    };
  }
  async searchUsers() {
    searched++;
    return {
      items: [await this.getUser("new_user")],
      pagination: {
        page: 1,
        page_size: 25,
        total: 1,
        total_pages: 1,
        has_next: false,
      },
      request_id: "test-search",
      retrieved_at: new Date().toISOString(),
    };
  }
}
async function denies(fn: () => Promise<unknown>, status: number) {
  try {
    await fn();
    assert.fail("Expected rejection");
  } catch (e) {
    assert.equal(mapAdminError(e).status, status);
  }
}
async function grantOperator(user = UA) {
  await db.pg.query(
    "INSERT INTO inventory.platform_operator_grants(app_user_id,can_provision,expires_at,granted_reason) VALUES($1,true,clock_timestamp()+interval '1 day','Test fixture')",
    [user],
  );
}
async function member(id: string) {
  const r = (await admin.data(token)).items.find((x) => x.id === id);
  assert.ok(r);
  return r;
}
before(async () => {
  await db.init();
  repo = new SessionRepository(db);
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.pg.exec(
    "DELETE FROM inventory.app_sessions; DELETE FROM inventory.sso_status_cache; DELETE FROM inventory.login_rate_limits; DELETE FROM inventory.platform_operator_grants;",
  );
  provider = new Provider();
  auth = new AuthService(
    repo,
    provider,
    "test-rate-secret-public-not-production",
  );
  admin = new AdminService(
    auth,
    provider,
    "test-rate-secret-public-not-production",
  );
  token = (await auth.login({ username: "test.admin.a", password: "valid" }))
    .token;
  searched = 0;
});
test("Tenant admin data returns only own tenant members and display snapshots", async () => {
  const d = await admin.data(token);
  assert.equal(d.tenant.id, A);
  assert.equal(
    d.items.some((x) => x.id === MB),
    false,
  );
  assert.equal(d.roles.length, 3);
  assert.ok(d.items.every((x) => !("password" in x)));
});
test("Viewer is denied directory, provisioning and member mutation before SSO directory calls", async () => {
  provider.id = "test_viewer";
  const v = (await auth.login({ username: "test.viewer", password: "valid" }))
    .token;
  await denies(() => admin.search(v, "guru", 1, "tenant"), 403);
  await denies(() => admin.platformData(v), 403);
  await denies(
    () =>
      admin.add(v, {
        sso_user_id: "new_user",
        role: "admin",
        status: "active",
      }),
    403,
  );
  assert.equal(searched, 0);
});
test("Directory rejects anonymous access and unfiltered enumeration", async () => {
  await denies(() => admin.search(undefined, "guru", 1, "tenant"), 401);
  await denies(() => admin.search(token, "", 1, "tenant"), 400);
  assert.equal(searched, 0);
});
test("Directory options come from SSO and only expose minimum identity fields", async () => {
  const d = await admin.search(token, "pengguna", 1, "tenant");
  assert.equal(searched, 1);
  assert.deepEqual(Object.keys(d.items[0]).sort(), [
    "full_name",
    "sso_user_id",
    "username",
  ]);
  assert.equal(d.items[0].sso_user_id, "new_user");
});
test("Directory budgets are persisted and block requests beyond user budget", async () => {
  for (let i = 0; i < 10; i++)
    await admin.search(token, "pengguna", 1, "tenant");
  await denies(() => admin.search(token, "pengguna", 1, "tenant"), 429);
  assert.equal(searched, 10);
});
test("Adding a centrally active user creates a local membership without a password", async () => {
  const id = "member_" + randomUUID().replaceAll("-", "");
  const r = await admin.add(token, {
    sso_user_id: id,
    role: "petugas",
    status: "active",
  });
  const d = await member(r.id);
  assert.equal(d.sso_user_id, id);
  assert.equal(d.role_code, "petugas");
  assert.ok(
    (await admin.data(token)).history.some(
      (h) => h.action === "member_added" && h.resource_id === r.id,
    ),
  );
});
test("Duplicate membership is rejected instead of silently creating another row", async () => {
  const id = "dup_" + randomUUID().replaceAll("-", "");
  await admin.add(token, { sso_user_id: id, role: "viewer", status: "active" });
  await denies(
    () =>
      admin.add(token, { sso_user_id: id, role: "admin", status: "active" }),
    409,
  );
});
test("Inactive central user is rejected and unknown form fields cannot supply tenant/role IDs", async () => {
  await denies(
    () =>
      admin.add(token, {
        sso_user_id: "inactive_user",
        role: "petugas",
        status: "active",
      }),
    400,
  );
  await denies(
    () =>
      admin.add(token, {
        sso_user_id: "new_user",
        role: "petugas",
        status: "active",
        tenant_id: B,
      }),
    400,
  );
});
test("Admin cannot update self or access another tenant membership by ID", async () => {
  const own = await member(MA);
  await denies(
    () =>
      admin.update(token, {
        membership_id: MA,
        role: "viewer",
        status: "inactive",
        row_version: own.row_version,
      }),
    403,
  );
  await denies(
    () =>
      admin.update(token, {
        membership_id: MB,
        role: "viewer",
        status: "active",
        row_version: 1,
      }),
    404,
  );
});
test("Membership role/status change revokes affected sessions immediately", async () => {
  const id = "change_" + randomUUID().replaceAll("-", "");
  const r = await admin.add(token, {
    sso_user_id: id,
    role: "viewer",
    status: "active",
  });
  provider.id = id;
  const target = (
    await auth.login({ username: "new.member", password: "valid" })
  ).token;
  provider.id = "test_admin_a";
  const m = await member(r.id);
  await admin.update(token, {
    membership_id: r.id,
    role: "petugas",
    status: "inactive",
    row_version: m.row_version,
  });
  await denies(() => auth.session(target), 401);
  const d = await member(r.id);
  assert.equal(d.role_code, "petugas");
  assert.equal(d.status, "inactive");
  assert.ok(
    (await admin.data(token)).history.some(
      (h) => h.action === "member_changed" && h.resource_id === r.id,
    ),
  );
});
test("Optimistic membership version prevents stale writes", async () => {
  const id = "version_" + randomUUID().replaceAll("-", "");
  const r = await admin.add(token, {
    sso_user_id: id,
    role: "viewer",
    status: "active",
  });
  const m = await member(r.id);
  await admin.update(token, {
    membership_id: r.id,
    role: "viewer",
    status: "inactive",
    row_version: m.row_version,
  });
  await denies(
    () =>
      admin.update(token, {
        membership_id: r.id,
        role: "admin",
        status: "active",
        row_version: m.row_version,
      }),
    409,
  );
});
test("Database denies direct membership updates even if the runtime connection is used", async () => {
  const x = await auth.session(token);
  await denies(
    () =>
      repo.db.run(
        "runtime",
        {
          tenantId: A,
          userId: UA,
          membershipId: MA,
          sessionDigest: tokenDigest(token),
        },
        (q) =>
          q.query(
            "UPDATE inventory.tenant_memberships SET status='inactive' WHERE id=$1",
            [x.session.active_membership_id],
          ),
      ),
    403,
  );
});
test("Role matrix protects admin and administrative permissions", async () => {
  const d = await admin.data(token),
    adm = d.roles.find((r) => r.code === "admin")!,
    v = d.roles.find((r) => r.code === "viewer")!;
  await denies(
    () =>
      admin.permissions(token, {
        role_id: adm.id,
        permissions: [],
        row_version: adm.row_version,
      }),
    403,
  );
  await denies(
    () =>
      admin.permissions(token, {
        role_id: v.id,
        permissions: ["users.manage"],
        row_version: v.row_version,
      }),
    403,
  );
});
test("Role permission update bumps membership authorization and revokes existing viewer sessions", async () => {
  const d = await admin.data(token),
    role = d.roles.find((r) => r.code === "viewer")!;
  provider.id = "test_viewer";
  const view = (
    await auth.login({ username: "test.viewer", password: "valid" })
  ).token;
  provider.id = "test_admin_a";
  await admin.permissions(token, {
    role_id: role.id,
    permissions: [...role.permissions, "assets.export"],
    row_version: role.row_version,
  });
  await denies(() => auth.session(view), 401);
  const changed = (await admin.data(token)).roles.find(
    (r) => r.id === role.id,
  )!;
  assert.ok(changed.permissions.includes("assets.export"));
  assert.ok(changed.row_version > role.row_version);
});
test("Profile changes stay in tenant A and stale version is rejected", async () => {
  const d = await admin.data(token),
    payload = {
      name: "Nama Lembaga Uji Baru",
      timezone: "Asia/Makassar",
      row_version: d.tenant.row_version,
      profile: {
        npsn: "12345678",
        nsm: "",
        address: "Alamat Uji",
        phone: "",
        email: "",
        principal_name: "Kepala Uji",
      },
    };
  await admin.profile(token, payload);
  const changed = await admin.data(token);
  assert.equal(changed.tenant.name, payload.name);
  assert.equal(changed.tenant.profile.npsn, "12345678");
  assert.equal(changed.tenant.timezone, "Asia/Makassar");
  const other = (
    await db.pg.query<{ name: string }>(
      "SELECT name FROM inventory.tenants WHERE id=$1",
      [B],
    )
  ).rows[0].name;
  assert.equal(other, "Lembaga Uji B");
  await denies(() => admin.profile(token, payload), 409);
});
test("Invalid profile fields and configuration keys are rejected", async () => {
  const d = await admin.data(token);
  await denies(
    () =>
      admin.profile(token, {
        name: "X",
        timezone: "Asia/Jakarta",
        row_version: d.tenant.row_version,
        profile: { token_ciphertext: "forged" },
      }),
    400,
  );
});
test("Ordinary tenant admin has no platform listing or provisioning privileges", async () => {
  await denies(() => admin.platformData(token), 403);
  await denies(
    () =>
      admin.provision(token, {
        code: "DENIED",
        name: "Tidak Boleh",
        admin_sso_user_id: "new_user",
        idempotency_key: randomUUID(),
      }),
    403,
  );
});
test("Operator can provision setup tenant idempotently without receiving tenant membership", async () => {
  await grantOperator();
  const key = randomUUID(),
    payload = {
      code: "TEN_" + randomUUID().slice(0, 8).toUpperCase(),
      name: "Lembaga Baru",
      admin_sso_user_id: "first_" + randomUUID().replaceAll("-", ""),
      idempotency_key: key,
    };
  const a = await admin.provision(token, payload),
    b = await admin.provision(token, payload);
  assert.equal(a.id, b.id);
  assert.equal(b.reused, true);
  const rows = await db.pg.query<{ status: string }>(
    "SELECT status FROM inventory.tenants WHERE id=$1",
    [a.id],
  );
  assert.equal(rows.rows[0].status, "setup");
  assert.equal(
    (
      await db.pg.query(
        "SELECT id FROM inventory.tenant_memberships WHERE tenant_id=$1 AND app_user_id=$2",
        [a.id, UA],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.pg.query("SELECT id FROM inventory.roles WHERE tenant_id=$1", [
        a.id,
      ])
    ).rows.length,
    3,
  );
  await denies(
    () => admin.provision(token, { ...payload, name: "Changed" }),
    409,
  );
});
test("Expired operator grant does not allow platform access", async () => {
  await grantOperator();
  await db.pg.query(
    "UPDATE inventory.platform_operator_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE app_user_id=$1",
    [UA],
  );
  await denies(() => admin.platformData(token), 403);
});
test("Platform provisioning requires recent authentication even with fresh central status", async () => {
  await grantOperator();
  await db.pg.query(
    "UPDATE inventory.app_sessions SET authenticated_at=clock_timestamp()-interval '16 minute' WHERE token_digest=$1",
    [tokenDigest(token)],
  );
  await denies(
    () =>
      admin.provision(token, {
        code: "FRESH_" + randomUUID().slice(0, 6).toUpperCase(),
        name: "Fresh",
        admin_sso_user_id: "new_user",
        idempotency_key: randomUUID(),
      }),
    401,
  );
});
test("Operator-only account logs in to the platform and cannot read tenant inventory", async () => {
  const uid = randomUUID(),
    sso = "operator_" + randomUUID().replaceAll("-", "");
  await db.pg.query(
    "INSERT INTO inventory.app_users(id,sso_user_id,username_snapshot,full_name_snapshot) VALUES($1,$2,$3,$4)",
    [uid, sso, "platform.operator", "Operator Uji"],
  );
  await grantOperator(uid);
  provider.id = sso;
  const r = await auth.login({
    username: "platform.operator",
    password: "valid",
  });
  assert.equal(r.next, "/platform/lembaga");
  assert.equal(
    (await auth.session(r.token, { tenant: false })).memberships.length,
    0,
  );
  await denies(() => admin.data(r.token), 409);
  assert.ok((await admin.platformData(r.token)).items.length >= 2);
});
test("First administrator can enter setup tenant with only administrative permissions", async () => {
  await grantOperator();
  const sso = "setup_" + randomUUID().replaceAll("-", "");
  const t = await admin.provision(token, {
    code: "SET_" + randomUUID().slice(0, 7).toUpperCase(),
    name: "Penyiapan",
    admin_sso_user_id: sso,
    idempotency_key: randomUUID(),
  });
  provider.id = sso;
  const r = await auth.login({ username: "new.member", password: "valid" });
  assert.equal(r.next, "/dashboard");
  const x = await auth.session(r.token);
  assert.equal(x.session.active_tenant_id, t.id);
  const p = await repo.permissions(x);
  assert.ok(p.includes("settings.manage"));
  assert.equal(p.includes("assets.create"), false);
  assert.equal((await admin.data(r.token)).tenant.status, "setup");
});
test("Activation without validated Drive is denied; suspension revokes tenant sessions", async () => {
  await grantOperator();
  let t = (await admin.platformData(token)).items.find((t) => t.id === B)!;
  await denies(
    () =>
      admin.tenantStatus(token, {
        tenant_id: B,
        status: "active",
        row_version: t.row_version,
        reason: "Aktivasi uji",
      }),
    409,
  );
  provider.id = "test_admin_b";
  const second = (
    await auth.login({ username: "test.admin.b", password: "valid" })
  ).token;
  provider.id = "test_admin_a";
  t = (await admin.platformData(token)).items.find((t) => t.id === B)!;
  await admin.tenantStatus(token, {
    tenant_id: B,
    status: "inactive",
    row_version: t.row_version,
    reason: "Penonaktifan uji",
  });
  await denies(() => auth.session(second), 401);
  await db.pg.query(
    "UPDATE inventory.tenants SET status='active' WHERE id=$1",
    [B],
  );
});
test("Controller enforces CSRF and denies a forged platform mode from tenant admin", async () => {
  const origin = "https://inventory.test.invalid",
    c = new AdminController(admin, origin),
    name = cookieNames(origin).session;
  const denied = await c.handle(
    "member-create",
    new Request(origin + "/api/admin/users/create", {
      method: "POST",
      headers: { Cookie: name + "=" + token },
      body: "{}",
    }),
  );
  assert.equal(denied.status, 403);
  const r = await c.handle(
    "directory",
    new Request(origin + "/api/admin/directory?query=test&mode=platform", {
      headers: { Cookie: name + "=" + token },
    }),
  );
  assert.equal(r.status, 403);
});
test("Privileged functions reject a forged session digest even with matching user and tenant context", async () => {
  await denies(
    () =>
      repo.db.run(
        "runtime",
        {
          tenantId: A,
          userId: UA,
          membershipId: MA,
          sessionDigest: "f".repeat(64),
        },
        (q) => q.query("SELECT inventory_security.tenant_admin_data(1)"),
      ),
    403,
  );
});
test("Platform functions are not executable by the tenant runtime role", async () => {
  await grantOperator();
  await denies(
    () =>
      repo.db.run(
        "runtime",
        {
          tenantId: A,
          userId: UA,
          membershipId: MA,
          sessionDigest: tokenDigest(token),
        },
        (q) => q.query("SELECT inventory_security.platform_tenants(1)"),
      ),
    403,
  );
});
test("Stale profile, forged role and foreign role IDs cannot bypass backend validation", async () => {
  const d = await admin.data(token);
  await denies(
    () =>
      admin.update(token, {
        membership_id: MA,
        role: "super_admin",
        status: "active",
        row_version: 1,
      }),
    400,
  );
  const rb = (
    await db.pg.query<{ id: string }>(
      "SELECT id FROM inventory.roles WHERE tenant_id=$1 AND code='viewer'",
      [B],
    )
  ).rows[0].id;
  await denies(
    () =>
      admin.permissions(token, {
        role_id: rb,
        permissions: ["dashboard.view"],
        row_version: 1,
      }),
    404,
  );
  assert.equal((await admin.data(token)).tenant.id, d.tenant.id);
});
test("Activation gate accepts a ready Drive metadata fixture; this does not call Google", async () => {
  await grantOperator();
  const connection = randomUUID();
  await db.pg.query(
    `INSERT INTO inventory.tenant_drive_connections(id,tenant_id,auth_mode,connection_version,root_folder_id,google_identity,status,last_tested_at,capabilities) VALUES($1,$2,'service_account',99,$3,'test-only-identity','ready',clock_timestamp(),'{"read_metadata":true,"list":true,"create_file":true,"create_folder":true,"cleanup":true}')`,
    [connection, B, "test-root-" + randomUUID()],
  );
  try {
    const t = (await admin.platformData(token)).items.find((x) => x.id === B)!;
    await admin.tenantStatus(token, {
      tenant_id: B,
      status: "active",
      row_version: t.row_version,
      reason: "Uji gate metadata",
    });
    assert.equal(
      (await admin.platformData(token)).items.find((x) => x.id === B)!.status,
      "active",
    );
  } finally {
    await db.pg.query(
      "UPDATE inventory.tenant_drive_connections SET status='retired' WHERE id=$1",
      [connection],
    );
  }
});
test("Failed provisioning of an inactive local admin rolls back tenant and reference data atomically", async () => {
  await grantOperator();
  const code = "ROLL_" + randomUUID().slice(0, 7).toUpperCase();
  await db.pg.query(
    "UPDATE inventory.app_users SET status='inactive' WHERE sso_user_id='test_viewer'",
  );
  try {
    await denies(
      () =>
        admin.provision(token, {
          code,
          name: "Rollback test",
          admin_sso_user_id: "test_viewer",
          idempotency_key: randomUUID(),
        }),
      409,
    );
    assert.equal(
      (
        await db.pg.query("SELECT id FROM inventory.tenants WHERE code=$1", [
          code,
        ])
      ).rows.length,
      0,
    );
  } finally {
    await db.pg.query(
      "UPDATE inventory.app_users SET status='active' WHERE sso_user_id='test_viewer'",
    );
  }
});
test("Admin cannot grant a permission not held in its own matrix", async () => {
  const d = await admin.data(token),
    a = d.roles.find((r) => r.code === "admin")!,
    v = d.roles.find((r) => r.code === "viewer")!;
  await db.pg.query(
    "DELETE FROM inventory.role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_code='assets.export'",
    [A, a.id],
  );
  try {
    await denies(
      () =>
        admin.permissions(token, {
          role_id: v.id,
          permissions: ["assets.export"],
          row_version: v.row_version,
        }),
      403,
    );
  } finally {
    await db.pg.query(
      "INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code) VALUES($1,$2,'assets.export') ON CONFLICT DO NOTHING",
      [A, a.id],
    );
  }
});
test("Controller rejects an old tenant form context instead of applying it to the newly active tenant", async () => {
  const origin = "https://inventory.test.invalid",
    controller = new AdminController(admin, origin),
    cookie = `${cookieNames(origin).session}=${token}`;
  const good = await controller.handle(
    "users",
    new Request(origin + "/api/admin/users", {
      headers: { Cookie: cookie, "X-Tenant-Context": A },
    }),
  );
  assert.equal(good.status, 200);
  const bad = await controller.handle(
    "users",
    new Request(origin + "/api/admin/users", {
      headers: { Cookie: cookie, "X-Tenant-Context": B },
    }),
  );
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).error.code, "TENANT_CONTEXT_CHANGED");
  const csrf = "e".repeat(64);
  const update = await controller.handle(
    "member-create",
    new Request(origin + "/api/admin/users/create", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie + `; ${cookieNames(origin).csrf}=${csrf}`,
        "X-CSRF-Token": csrf,
        "X-Tenant-Context": B,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sso_user_id: "stale_context_target",
        role: "petugas",
        status: "active",
      }),
    }),
  );
  assert.equal(update.status, 409);
  assert.equal(
    (
      await db.pg.query(
        "SELECT id FROM inventory.app_users WHERE sso_user_id='stale_context_target'",
      )
    ).rows.length,
    0,
  );
});
