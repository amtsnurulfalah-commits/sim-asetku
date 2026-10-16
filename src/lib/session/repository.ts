import "server-only";
import type { Database, Sql } from "../db/types";
import type { VerifiedIdentity } from "../sso/schemas";
import { AppError } from "../security/errors";
export type Membership = {
  id: string;
  tenant_id: string;
  role_id: string;
  authorization_version: string | number;
  tenant_name: string;
  tenant_status: string;
};
export type SessionRow = {
  id: string;
  token_digest: string;
  app_user_id: string;
  active_tenant_id: string | null;
  active_membership_id: string | null;
  identity_version: string | number;
  authorization_version: string | number | null;
  authenticated_at: Date;
  expires_at: Date;
  idle_expires_at: Date;
  last_sso_check_at: Date;
  revoked_at: Date | null;
};
export type Snapshot = {
  session: SessionRow;
  user: {
    id: string;
    sso_user_id: string;
    full_name_snapshot: string;
    username_snapshot: string;
    status: string;
  };
  memberships: Membership[];
  is_operator: boolean;
};
export type StatusCache = {
  identity_version: string | number;
  can_authenticate: boolean;
  checked_at: Date;
  valid_until: Date;
};
const activeMemberships = async (q: Sql, userId: string) =>
  (
    await q.query<Membership>(
      `SELECT m.id,m.tenant_id,m.role_id,m.authorization_version,t.name AS tenant_name,t.status AS tenant_status
 FROM inventory.tenant_memberships m JOIN inventory.tenants t ON t.id=m.tenant_id
 WHERE m.app_user_id=$1 AND m.status='active' AND t.status IN ('setup','active') ORDER BY t.name,m.id`,
      [userId],
    )
  ).rows;
export class SessionRepository {
  constructor(public db: Database) {}
  async event(event: string, resultCode: string, userId?: string) {
    return this.db.run("auth", { userId }, async (q) => {
      await q.query(
        "INSERT INTO inventory.auth_events(app_user_id,event,result_code) VALUES($1,$2,$3)",
        [userId ?? null, event, resultCode],
      );
    });
  }
  async limit(digest: string, max: number, windowSeconds: number) {
    return this.db.run("auth", { rateDigest: digest }, async (q) => {
      const r = await q.query<{ attempts: number }>(
        `INSERT INTO inventory.login_rate_limits(key_digest,window_started_at,attempts) VALUES($1,clock_timestamp(),1)
 ON CONFLICT(key_digest) DO UPDATE SET
 attempts=CASE WHEN inventory.login_rate_limits.window_started_at<clock_timestamp()-make_interval(secs=>$2) THEN 1 ELSE inventory.login_rate_limits.attempts+1 END,
 window_started_at=CASE WHEN inventory.login_rate_limits.window_started_at<clock_timestamp()-make_interval(secs=>$2) THEN clock_timestamp() ELSE inventory.login_rate_limits.window_started_at END RETURNING attempts`,
        [digest, windowSeconds],
      );
      return r.rows[0].attempts <= max;
    });
  }
  async create(identity: VerifiedIdentity, digest: string, now: Date) {
    return this.db.run("auth", { ssoId: identity.sso_user_id }, async (q) => {
      const row = (
        await q.query<{ id: string; status: string }>(
          "SELECT id,status FROM inventory.app_users WHERE sso_user_id=$1 FOR SHARE",
          [identity.sso_user_id],
        )
      ).rows[0];
      if (!row || row.status !== "active")
        throw new AppError(
          "LOCAL_ACCESS_DENIED",
          403,
          "Akun belum memiliki akses aktif ke aplikasi Inventaris.",
        );
      await q.query("SELECT set_config('app.user_id',$1,true)", [row.id]);
      const members = await activeMemberships(q, row.id);
      const operator =
        (
          await q.query(
            "SELECT id FROM inventory.platform_operator_grants WHERE app_user_id=$1 AND can_provision AND expires_at>clock_timestamp()",
            [row.id],
          )
        ).rows.length > 0;
      if (!members.length && !operator)
        throw new AppError(
          "LOCAL_ACCESS_DENIED",
          403,
          "Akun belum memiliki akses aktif ke aplikasi Inventaris.",
        );
      await q.query(
        "UPDATE inventory.app_users SET username_snapshot=$1,full_name_snapshot=$2 WHERE id=$3",
        [identity.username, identity.full_name, row.id],
      );
      const m = members.length === 1 ? members[0] : null;
      await q.query(
        `INSERT INTO inventory.app_sessions(token_digest,app_user_id,active_tenant_id,active_membership_id,identity_version,authorization_version,authenticated_at,expires_at,idle_expires_at,last_sso_check_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '8 hour',$7::timestamptz+interval '30 minute',$7)`,
        [
          digest,
          row.id,
          m?.tenant_id ?? null,
          m?.id ?? null,
          identity.identity_version,
          m?.authorization_version ?? null,
          now,
        ],
      );
      await this.writeStatus(q, row.id, identity.identity_version, true, now);
      await q.query(
        "INSERT INTO inventory.auth_events(app_user_id,event,result_code) VALUES($1,'login','OK')",
        [row.id],
      );
      return {
        userId: row.id,
        selected: !!m,
        operatorOnly: operator && !members.length,
      };
    });
  }
  private async loadIn(q: Sql, digest: string): Promise<Snapshot | null> {
    const s = (
      await q.query<SessionRow>(
        "SELECT * FROM inventory.app_sessions WHERE token_digest=$1 FOR UPDATE",
        [digest],
      )
    ).rows[0];
    if (!s) return null;
    await q.query("SELECT set_config('app.user_id',$1,true)", [s.app_user_id]);
    const user = (
      await q.query<Snapshot["user"]>(
        "SELECT id,sso_user_id,username_snapshot,full_name_snapshot,status FROM inventory.app_users WHERE id=$1",
        [s.app_user_id],
      )
    ).rows[0];
    if (!user) return null;
    return {
      session: s,
      user,
      memberships: await activeMemberships(q, s.app_user_id),
      is_operator:
        (
          await q.query(
            "SELECT id FROM inventory.platform_operator_grants WHERE app_user_id=$1 AND can_provision AND expires_at>clock_timestamp()",
            [s.app_user_id],
          )
        ).rows.length > 0,
    };
  }
  load(digest: string) {
    return this.db.run("auth", { sessionDigest: digest }, (q) =>
      this.loadIn(q, digest),
    );
  }
  cache(userId: string) {
    return this.db.run(
      "auth",
      { userId },
      async (q) =>
        (
          await q.query<StatusCache>(
            "SELECT identity_version,can_authenticate,checked_at,valid_until FROM inventory.sso_status_cache WHERE app_user_id=$1",
            [userId],
          )
        ).rows[0] ?? null,
    );
  }
  private async writeStatus(
    q: Sql,
    userId: string,
    version: number | string,
    canAuth: boolean,
    checked: Date,
  ) {
    await q.query(
      `INSERT INTO inventory.sso_status_cache(app_user_id,identity_version,can_authenticate,checked_at,valid_until) VALUES($1,$2,$3,$4,$4::timestamptz+interval '60 second')
 ON CONFLICT(app_user_id) DO UPDATE SET identity_version=EXCLUDED.identity_version,can_authenticate=EXCLUDED.can_authenticate,checked_at=EXCLUDED.checked_at,valid_until=EXCLUDED.valid_until
 WHERE inventory.sso_status_cache.checked_at<=EXCLUDED.checked_at`,
      [userId, version, canAuth, checked],
    );
  }
  status(userId: string, version: number, canAuth: boolean, checked: Date) {
    return this.db.run("auth", { userId }, (q) =>
      this.writeStatus(q, userId, version, canAuth, checked),
    );
  }
  revoke(digest: string, event = "logout") {
    return this.db.run("auth", { sessionDigest: digest }, async (q) => {
      const s = (
        await q.query<{ app_user_id: string }>(
          "SELECT app_user_id FROM inventory.app_sessions WHERE token_digest=$1 FOR UPDATE",
          [digest],
        )
      ).rows[0];
      if (!s) return;
      await q.query("SELECT set_config('app.user_id',$1,true)", [
        s.app_user_id,
      ]);
      await q.query(
        "UPDATE inventory.app_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE token_digest=$1",
        [digest],
      );
      await q.query(
        "INSERT INTO inventory.auth_events(app_user_id,event,result_code) VALUES($1,$2,$3)",
        [s.app_user_id, event, "OK"],
      );
    });
  }
  revokeUser(userId: string) {
    return this.db.run("auth", { userId }, async (q) => {
      await q.query(
        "UPDATE inventory.app_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE app_user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
      await q.query(
        "INSERT INTO inventory.auth_events(app_user_id,event,result_code) VALUES($1,'session_revoked','IDENTITY_CHANGED')",
        [userId],
      );
    });
  }
  async touch(digest: string, now: Date) {
    return this.db.run("auth", { sessionDigest: digest }, async (q) => {
      const x = await this.loadIn(q, digest);
      if (!x || !this.validLocal(x, now)) return null;
      const c = (
        await q.query<StatusCache>(
          "SELECT identity_version,can_authenticate,checked_at,valid_until FROM inventory.sso_status_cache WHERE app_user_id=$1",
          [x.user.id],
        )
      ).rows[0];
      if (
        !c ||
        !c.can_authenticate ||
        Number(c.identity_version) !== Number(x.session.identity_version) ||
        new Date(c.valid_until).getTime() <= now.getTime()
      )
        return null;
      await q.query(
        `UPDATE inventory.app_sessions SET last_seen_at=$1,idle_expires_at=LEAST(expires_at,$1::timestamptz+interval '30 minute'),last_sso_check_at=$2 WHERE token_digest=$3`,
        [now, c.checked_at, digest],
      );
      return x;
    });
  }
  validLocal(x: Snapshot, now: Date) {
    const s = x.session;
    if (
      s.revoked_at ||
      new Date(s.expires_at).getTime() <= now.getTime() ||
      new Date(s.idle_expires_at).getTime() <= now.getTime() ||
      x.user.status !== "active" ||
      (!x.memberships.length && !x.is_operator)
    )
      return false;
    if (!s.active_tenant_id) return true;
    return x.memberships.some(
      (m) =>
        m.id === s.active_membership_id &&
        m.tenant_id === s.active_tenant_id &&
        Number(m.authorization_version) === Number(s.authorization_version),
    );
  }
  async rotate(digest: string, newDigest: string, tenantId: string, now: Date) {
    return this.db.run("auth", { sessionDigest: digest }, async (q) => {
      const x = await this.loadIn(q, digest);
      if (!x || !this.validLocal(x, now))
        throw new AppError(
          "SESSION_INVALID",
          401,
          "Sesi berakhir. Silakan masuk kembali.",
        );
      const m = x.memberships.find((m) => m.tenant_id === tenantId);
      if (!m)
        throw new AppError(
          "TENANT_DENIED",
          403,
          "Akses lembaga tidak diizinkan.",
        );
      await q.query(
        "UPDATE inventory.app_sessions SET revoked_at=$1 WHERE token_digest=$2",
        [now, digest],
      );
      // Preserve absolute authentication/expiry; switching tenant never extends 8-hour lifetime.
      await q.query(
        `INSERT INTO inventory.app_sessions(token_digest,app_user_id,active_tenant_id,active_membership_id,identity_version,authorization_version,authenticated_at,expires_at,idle_expires_at,last_sso_check_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST($8::timestamptz,$9::timestamptz+interval '30 minute'),$10)`,
        [
          newDigest,
          x.user.id,
          m.tenant_id,
          m.id,
          x.session.identity_version,
          m.authorization_version,
          x.session.authenticated_at,
          x.session.expires_at,
          now,
          x.session.last_sso_check_at,
        ],
      );
      await q.query(
        "INSERT INTO inventory.auth_events(app_user_id,event,result_code) VALUES($1,'tenant_switch','OK')",
        [x.user.id],
      );
    });
  }
  permissions(x: Snapshot, permission?: string) {
    const s = x.session;
    return this.db.run(
      "runtime",
      {
        tenantId: s.active_tenant_id ?? undefined,
        userId: x.user.id,
        membershipId: s.active_membership_id ?? undefined,
      },
      async (q) => {
        const active = (
          await q.query<{ authorization_version: string }>(
            "SELECT authorization_version FROM inventory.tenant_memberships WHERE id=$1 AND app_user_id=$2 AND tenant_id=$3 AND status=$4",
            [s.active_membership_id, x.user.id, s.active_tenant_id, "active"],
          )
        ).rows[0];
        if (
          !active ||
          Number(active.authorization_version) !==
            Number(s.authorization_version)
        )
          throw new AppError(
            "SESSION_INVALID",
            401,
            "Sesi berakhir. Silakan masuk kembali.",
          );
        const r = await q.query<{ permission_code: string }>(
          `SELECT rp.permission_code FROM inventory.role_permissions rp JOIN inventory.tenant_memberships m ON m.tenant_id=rp.tenant_id AND m.role_id=rp.role_id WHERE m.id=$1 AND m.tenant_id=$2
 UNION SELECT permission_code FROM inventory.membership_permission_grants WHERE membership_id=$1 AND tenant_id=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp())`,
          [s.active_membership_id, s.active_tenant_id],
        );
        let list = r.rows.map((p) => p.permission_code);
        if (
          x.memberships.find((m) => m.tenant_id === s.active_tenant_id)
            ?.tenant_status === "setup"
        )
          list = list.filter((p) =>
            [
              "dashboard.view",
              "users.manage",
              "settings.manage",
              "approval.manage",
            ].includes(p),
          );
        if (permission && !list.includes(permission))
          throw new AppError(
            "PERMISSION_DENIED",
            403,
            "Anda tidak memiliki izin untuk tindakan ini.",
          );
        return list;
      },
    );
  }
}
