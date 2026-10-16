import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { AppError, unauthorized, unavailable } from "../security/errors";
import { SsoError } from "../sso/client";
import {
  loginInput,
  type VerifiedIdentity,
  type UserStatus,
} from "../sso/schemas";
import { SessionRepository, type Snapshot } from "./repository";
export const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("hex");
export interface IdentityProvider {
  authenticate(username: string, password: string): Promise<VerifiedIdentity>;
  getUserStatus(id: string): Promise<UserStatus>;
}
export class AuthService {
  private pending = new Map<string, Promise<void>>();
  constructor(
    public repo: SessionRepository,
    private sso: IdentityProvider,
    private rateSecret: string,
    private clock: () => Date = () => new Date(),
  ) {}
  async login(raw: unknown, previousToken?: string, source?: string) {
    const input = loginInput.safeParse(raw);
    if (!input.success)
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        "Periksa format username dan password.",
      );
    const key = (s: string) =>
      createHmac("sha256", this.rateSecret).update(s).digest("hex");
    const budgets: [string, number, number][] = [
      ["global", 90, 900],
      ["account:" + input.data.username, 5, 900],
    ];
    if (source && isIP(source)) budgets.push(["source:" + source, 20, 900]);
    for (const [id, max, window] of budgets)
      if (!(await this.repo.limit(key(id), max, window)))
        throw new AppError(
          "RATE_LIMITED",
          429,
          "Terlalu banyak percobaan masuk. Coba kembali beberapa saat lagi.",
        );
    try {
      const verified = await this.sso.authenticate(
        input.data.username,
        input.data.password,
      );
      if (verified.account_status !== "active")
        throw new AppError(
          "INVALID_CREDENTIALS",
          401,
          "Kredensial tidak valid atau akun tidak dapat digunakan.",
        );
      if (previousToken && /^[0-9a-f]{64}$/.test(previousToken))
        await this.repo.revoke(tokenDigest(previousToken), "session_revoked");
      const rawToken = token(),
        now = this.clock();
      const access = await this.repo.create(
        verified,
        tokenDigest(rawToken),
        now,
      );
      return {
        token: rawToken,
        next: access.selected
          ? "/dashboard"
          : access.operatorOnly
            ? "/platform/lembaga"
            : "/pilih-lembaga",
        expires: new Date(now.getTime() + 8 * 3600000),
      };
    } catch (e) {
      const code =
        e instanceof SsoError
          ? e.code
          : e instanceof AppError
            ? e.code
            : "INTERNAL_ERROR";
      await this.repo.event("login_denied", code).catch(() => {});
      if (e instanceof AppError) throw e;
      if (e instanceof SsoError && e.code === "INVALID_CREDENTIALS")
        throw new AppError(
          "INVALID_CREDENTIALS",
          401,
          "Kredensial tidak valid atau akun tidak dapat digunakan.",
        );
      if (e instanceof SsoError && e.code === "RATE_LIMITED")
        throw new AppError(
          "RATE_LIMITED",
          429,
          "Layanan autentikasi sedang membatasi permintaan. Coba kembali nanti.",
        );
      throw unavailable();
    }
  }
  async session(
    rawToken: string | undefined,
    options: {
      tenant?: boolean;
      sensitive?: boolean;
      permission?: string;
    } = {},
  ): Promise<Snapshot> {
    if (!rawToken || !/^[0-9a-f]{64}$/.test(rawToken)) throw unauthorized();
    const digest = tokenDigest(rawToken),
      now = this.clock();
    const x = await this.repo.load(digest);
    if (!x || !this.repo.validLocal(x, now)) {
      if (x && !x.session.revoked_at)
        await this.repo.revoke(digest, "session_revoked");
      throw unauthorized();
    }
    const cached = await this.repo.cache(x.user.id);
    if (
      cached &&
      (!cached.can_authenticate ||
        Number(cached.identity_version) !== Number(x.session.identity_version))
    ) {
      await this.repo.revokeUser(x.user.id);
      throw unauthorized();
    }
    if (
      options.sensitive ||
      !cached ||
      new Date(cached.valid_until).getTime() <= now.getTime()
    ) {
      const check = async () => {
        const started = this.clock();
        try {
          const s = await this.sso.getUserStatus(x.user.sso_user_id);
          if (s.sso_user_id !== x.user.sso_user_id) throw unavailable();
          await this.repo.status(
            x.user.id,
            s.identity_version,
            s.can_authenticate,
            started,
          );
          if (
            !s.can_authenticate ||
            s.is_archived ||
            s.account_status !== "active" ||
            s.identity_version !== Number(x.session.identity_version)
          ) {
            await this.repo.revokeUser(x.user.id);
            throw unauthorized();
          }
        } catch (e) {
          if (e instanceof SsoError && e.code === "NOT_FOUND") {
            await this.repo.revokeUser(x.user.id);
            throw unauthorized();
          }
          if (e instanceof AppError) throw e;
          throw unavailable();
        }
      };
      if (options.sensitive) await check();
      else {
        let pending = this.pending.get(x.user.id);
        if (!pending) {
          pending = check();
          this.pending.set(x.user.id, pending);
        }
        try {
          await pending;
        } finally {
          if (this.pending.get(x.user.id) === pending)
            this.pending.delete(x.user.id);
        }
      }
    }
    const current = await this.repo.touch(digest, this.clock());
    if (!current) throw unauthorized();
    if (options.tenant !== false && !current.session.active_tenant_id)
      throw new AppError(
        "TENANT_REQUIRED",
        409,
        "Pilih lembaga terlebih dahulu.",
      );
    if (options.permission)
      await this.repo.permissions(current, options.permission);
    return current;
  }
  async switchTenant(rawToken: string | undefined, tenantId: string) {
    const x = await this.session(rawToken, { tenant: false, sensitive: true });
    const raw = token();
    await this.repo.rotate(
      tokenDigest(rawToken!),
      tokenDigest(raw),
      tenantId,
      this.clock(),
    );
    return {
      token: raw,
      next: "/dashboard",
      expires: new Date(x.session.expires_at),
    };
  }
  async logout(rawToken: string | undefined) {
    if (rawToken && /^[0-9a-f]{64}$/.test(rawToken))
      await this.repo.revoke(tokenDigest(rawToken));
    return { next: "/login" };
  }
}
