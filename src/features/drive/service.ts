import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { type Sql } from "@/lib/db/types";
import { AuthService, tokenDigest } from "@/lib/session/service";
import type { Snapshot } from "@/lib/session/repository";
import { AppError } from "@/lib/security/errors";
import {
  Vault,
  folderId,
  secret,
  digest,
  fail,
  PURPOSES,
  CHUNK_SIZE,
  assertFolder,
  assertDescendant,
  probeConnection,
  validateFile,
  verifyMagic,
  type DrivePort,
} from "@/lib/drive/core";
import {
  googleConfig,
  serviceDrive,
  oauthClient,
  oauthDrive,
  type GoogleConfig,
} from "@/lib/drive/google";
type Connection = {
  id: string;
  auth_mode: string;
  root_folder_id: string;
  root_folder_name: string | null;
  root_ancestor_ids: string[];
  drive_id: string | null;
  google_identity: string;
  status: string;
  token_ciphertext: string | null;
  encryption_key_id: string | null;
  last_tested_at: string | null;
  capabilities: Record<string, boolean>;
  last_error_code: string | null;
};
type Upload = {
  id: string;
  file_id: string;
  actor_id: string;
  status: string;
  expected_size: string;
  confirmed_offset: string;
  resumable_uri_ciphertext: string | null;
  encryption_key_id: string | null;
  first_chunk_verified: boolean;
  google_file_id: string;
  original_filename: string;
  mime_type: string;
  folder_google_id: string;
  connection_id: string;
  checksum: string | null;
  expires_at: string;
};
export type DriveData = {
  connections: Omit<Connection, "token_ciphertext" | "encryption_key_id">[];
  files: {
    id: string;
    original_filename: string;
    mime_type: string;
    file_size: string;
    status: string;
    sensitivity: string;
    created_at: string;
  }[];
  tenantId: string;
  maxBytes: number;
  purposes: readonly string[];
};
export class DriveService {
  private scopes = new WeakMap<Snapshot, string>();
  constructor(
    public auth: AuthService,
    private vault: Vault,
    private c: GoogleConfig,
    private provider?: (connection: Connection) => DrivePort,
  ) {}
  private async scope(
    token: string | undefined,
    permission = "settings.manage",
    sensitive = true,
  ) {
    const x = await this.auth.session(token, { permission, sensitive });
    this.scopes.set(x, permission);
    return x;
  }
  private run<T>(
    x: Snapshot,
    token: string | undefined,
    fn: (sql: Sql) => Promise<T>,
  ) {
    return this.auth.repo.db.run(
      "runtime",
      {
        tenantId: x.session.active_tenant_id!,
        membershipId: x.session.active_membership_id!,
        userId: x.user.id,
        sessionDigest: tokenDigest(token!),
        correlationId: randomUUID(),
      },
      async (q) => {
        const permission = this.scopes.get(x);
        if (!permission) fail("DRIVE_ACCESS_DENIED", 403);
        await q.query("SELECT inventory_security.assert_drive_actor($1)", [
          permission,
        ]);
        return fn(q);
      },
    );
  }
  private parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const x = schema.safeParse(input);
    if (!x.success) fail("VALIDATION_ERROR", 400);
    return x.data;
  }
  private async connection(x: Snapshot, t: string | undefined, id?: string) {
    const r = await this.run(x, t, (q) =>
      q.query<Connection>(
        "SELECT * FROM inventory.tenant_drive_connections WHERE " +
          (id ? "id=$1" : "status='ready'") +
          " LIMIT 1",
        id ? [id] : [],
      ),
    );
    if (!r.rows[0]) fail("DRIVE_NOT_CONNECTED", 409);
    return r.rows[0];
  }
  private port(x: Snapshot, c: Connection): DrivePort {
    if (this.provider) return this.provider(c);
    if (c.auth_mode === "service_account") return serviceDrive(this.c);
    if (!c.token_ciphertext || !c.encryption_key_id)
      fail("DRIVE_CREDENTIAL_INVALID");
    return oauthDrive(
      this.c,
      this.vault.open(
        c.token_ciphertext,
        c.encryption_key_id,
        `${x.session.active_tenant_id}:${c.id}:oauth`,
      ),
    );
  }
  private async verifyRoot(p: DrivePort, c: Connection) {
    let f = await p.get(c.root_folder_id);
    if (f.trashed || f.mimeType !== "application/vnd.google-apps.folder")
      fail("DRIVE_ACCESS_DENIED", 403);
    const actual: string[] = [];
    for (let i = 0; f.parents?.length && i < 100; i++) {
      if (f.parents.length !== 1 || actual.includes(f.parents[0]))
        fail("DRIVE_ROOT_MOVED", 409);
      actual.push(f.parents[0]);
      f = await p.get(f.parents[0]);
      if (f.trashed) fail("DRIVE_ROOT_MOVED", 409);
    }
    if (
      f.parents?.length ||
      JSON.stringify(actual) !== JSON.stringify(c.root_ancestor_ids)
    )
      fail("DRIVE_ROOT_MOVED", 409);
  }
  async data(token: string | undefined, filesOnly = false): Promise<DriveData> {
    const x = await this.scope(
      token,
      filesOnly ? "files.download" : "settings.manage",
      false,
    );
    return this.run(x, token, async (q) => ({
      tenantId: x.session.active_tenant_id!,
      maxBytes: this.c.maxBytes,
      purposes: PURPOSES,
      connections: filesOnly
        ? []
        : (
            await q.query<DriveData["connections"][number]>(
              "SELECT id,auth_mode,root_folder_id,root_folder_name,root_ancestor_ids,drive_id,google_identity,status,last_tested_at,capabilities,last_error_code FROM inventory.tenant_drive_connections ORDER BY created_at DESC LIMIT 20",
            )
          ).rows,
      files: (
        await q.query<DriveData["files"][number]>(
          "SELECT id,original_filename,mime_type,file_size,status,sensitivity,created_at FROM inventory.file_attachments ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    }));
  }
  private async createConnection(
    x: Snapshot,
    t: string | undefined,
    root: string,
    mode: string,
    refresh?: string,
    identity?: string,
  ) {
    const id = randomUUID(),
      sealed = refresh
        ? this.vault.seal(refresh, `${x.session.active_tenant_id}:${id}:oauth`)
        : null;
    await this.run(x, t, async (q) => {
      await q.query("SELECT inventory_security.drive_admin_guard()");
      await q.query(
        "UPDATE inventory.tenant_drive_connections SET status='failed',last_error_code='REPLACED_PENDING' WHERE status='pending'",
      );
      await q.query(
        `INSERT INTO inventory.tenant_drive_connections(id,tenant_id,auth_mode,connection_version,root_folder_id,google_identity,token_ciphertext,encryption_key_id)
      SELECT $1,$2,$3,coalesce(max(connection_version),0)+1,$4,$5,$6,$7 FROM inventory.tenant_drive_connections`,
        [
          id,
          x.session.active_tenant_id,
          mode,
          root,
          identity ?? this.c.serviceAccount?.client_email ?? "service-account",
          sealed?.ciphertext ?? null,
          sealed?.keyId ?? null,
        ],
      );
    });
    return id;
  }
  async configure(token: string | undefined, input: unknown) {
    const { folder } = this.parse(
        z.object({ folder: z.string().max(1000) }).strict(),
        input,
      ),
      root = folderId(folder),
      x = await this.scope(token);
    // Reject My Drive service-account use before recording a pending configuration.
    if (!this.provider) await assertFolder(serviceDrive(this.c), root, true);
    const id = await this.createConnection(x, token, root, "service_account");
    return this.test(token, { connectionId: id });
  }
  async oauthStart(token: string | undefined, input: unknown) {
    const { folder } = this.parse(
        z.object({ folder: z.string().max(1000) }).strict(),
        input,
      ),
      root = folderId(folder),
      x = await this.scope(token);
    const state = secret(),
      verifier = secret(),
      id = randomUUID(),
      v = this.vault.seal(verifier, `${x.session.active_tenant_id}:${id}:pkce`);
    await this.run(x, token, async (q) => {
      await q.query("SELECT inventory_security.drive_admin_guard()");
      await q.query(
        "INSERT INTO inventory.drive_oauth_states(id,tenant_id,actor_id,session_digest,state_digest,root_folder_id,verifier_ciphertext,encryption_key_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes')",
        [
          id,
          x.session.active_tenant_id,
          x.session.active_membership_id,
          tokenDigest(token!),
          digest(state),
          root,
          v.ciphertext,
          v.keyId,
        ],
      );
    });
    const url = oauthClient(this.c).generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/drive"],
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256" as never,
    });
    return { url };
  }
  async oauthCallback(token: string | undefined, state: string, code: string) {
    if (!/^[\w-]{43}$/.test(state) || !code || code.length > 4096)
      fail("OAUTH_STATE_INVALID", 400);
    const x = await this.scope(token),
      r = await this.run(x, token, (q) =>
        q.query<{
          id: string;
          root_folder_id: string;
          verifier_ciphertext: string;
          encryption_key_id: string;
        }>(
          "UPDATE inventory.drive_oauth_states SET consumed_at=clock_timestamp() WHERE state_digest=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id,root_folder_id,verifier_ciphertext,encryption_key_id",
          [digest(state)],
        ),
      );
    const s = r.rows[0];
    if (!s) fail("OAUTH_STATE_INVALID", 400);
    const client = oauthClient(this.c),
      verifier = this.vault.open(
        s.verifier_ciphertext,
        s.encryption_key_id,
        `${x.session.active_tenant_id}:${s.id}:pkce`,
      );
    const { tokens } = await client.getToken({
      code,
      codeVerifier: verifier,
      redirect_uri: this.c.redirectUri,
    });
    if (!tokens.refresh_token) fail("OAUTH_OFFLINE_REQUIRED", 409);
    const identity = await oauthDrive(this.c, tokens.refresh_token).identity();
    const id = await this.createConnection(
      x,
      token,
      s.root_folder_id,
      "oauth",
      tokens.refresh_token,
      identity,
    );
    return this.test(token, { connectionId: id });
  }
  async test(token: string | undefined, input: unknown) {
    const { connectionId } = this.parse(
        z.object({ connectionId: z.uuid() }).strict(),
        input,
      ),
      x = await this.scope(token),
      c = await this.connection(x, token, connectionId);
    if (["retired", "revoked"].includes(c.status))
      fail("DRIVE_RECONNECT_REQUIRED", 409);
    const claimed = await this.run(x, token, (q) =>
      q.query(
        "UPDATE inventory.tenant_drive_connections SET operation_lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1 AND (operation_lease_until IS NULL OR operation_lease_until<clock_timestamp()) RETURNING id",
        [c.id],
      ),
    );
    if (!claimed.rows.length) fail("DRIVE_BUSY", 409);
    const p = this.port(x, c);
    let result: { ready: boolean; capabilities: Record<string, boolean> };
    try {
      const root = await assertFolder(
        p,
        c.root_folder_id,
        c.auth_mode === "service_account",
      );
      const ancestors: string[] = [];
      let f = root;
      for (let n = 0; n < 100 && f.parents?.length; n++) {
        if (f.parents.length !== 1 || ancestors.includes(f.parents[0]))
          fail("DRIVE_ROOT_INVALID", 409);
        ancestors.push(f.parents[0]);
        f = await p.get(f.parents[0]);
        if (f.trashed) fail("DRIVE_ROOT_INVALID", 409);
      }
      if (f.parents?.length) fail("DRIVE_ROOT_INVALID", 409);
      await this.run(x, token, (q) =>
        q.query("SELECT inventory_security.claim_drive_root($1,$2)", [
          c.id,
          ancestors,
        ]),
      );
      result = await probeConnection(
        p,
        c.root_folder_id,
        c.auth_mode === "service_account",
        async (id) => {
          await this.run(x, token, (q) =>
            q.query(
              "INSERT INTO inventory.outbox_jobs(tenant_id,job_type,payload,idempotency_key) VALUES($1,'drive_probe_cleanup',$2,$3) ON CONFLICT DO NOTHING",
              [
                x.session.active_tenant_id,
                JSON.stringify({ connectionId: c.id, googleId: id }),
                "probe:" + id,
              ],
            ),
          );
        },
      );
      await this.run(x, token, async (q) => {
        await q.query("SELECT inventory_security.drive_admin_guard()");
        if (result.ready)
          await q.query(
            "UPDATE inventory.tenant_drive_connections SET status='retired' WHERE status='ready' AND id<>$1",
            [c.id],
          );
        await q.query(
          "UPDATE inventory.tenant_drive_connections SET status=$2,drive_id=$3,last_tested_at=clock_timestamp(),capabilities=$4,last_error_code=$5,root_folder_name=$6,operation_lease_until=NULL WHERE id=$1",
          [
            c.id,
            result.ready ? "ready" : "failed",
            root.driveId ?? null,
            JSON.stringify(result.capabilities),
            result.ready ? null : "PROBE_FAILED",
            root.name,
          ],
        );
      });
      return result;
    } catch (e) {
      await this.run(x, token, (q) =>
        q.query(
          "UPDATE inventory.tenant_drive_connections SET status='failed',operation_lease_until=NULL,last_tested_at=clock_timestamp(),last_error_code='TEST_FAILED',capabilities='{}' WHERE id=$1",
          [c.id],
        ),
      );
      throw e;
    }
  }
  async initialize(token: string | undefined) {
    const x = await this.scope(token),
      c = await this.connection(x, token),
      p = this.port(x, c);
    const lock = await this.run(x, token, (q) =>
      q.query(
        "UPDATE inventory.tenant_drive_connections SET operation_lease_until=clock_timestamp()+interval '10 minutes' WHERE id=$1 AND (operation_lease_until IS NULL OR operation_lease_until<clock_timestamp()) RETURNING id",
        [c.id],
      ),
    );
    if (!lock.rows.length) fail("DRIVE_BUSY", 409);
    try {
      await this.verifyRoot(p, c);
      await assertFolder(
        p,
        c.root_folder_id,
        c.auth_mode === "service_account",
      );
      for (const purpose of PURPOSES) {
        const found = await p.list(c.root_folder_id, {
          inventoryTenant: x.session.active_tenant_id!,
          inventoryPurpose: purpose,
        });
        if (found.length > 1) fail("DRIVE_FOLDER_DUPLICATE", 409);
        const f =
          found[0] ??
          (await p.folder(purpose, c.root_folder_id, {
            inventoryTenant: x.session.active_tenant_id!,
            inventoryPurpose: purpose,
          }));
        if (
          f.mimeType !== "application/vnd.google-apps.folder" ||
          f.parents?.[0] !== c.root_folder_id ||
          f.trashed
        )
          fail("DRIVE_FOLDER_INVALID", 409);
        await this.run(x, token, (q) =>
          q.query(
            "INSERT INTO inventory.tenant_drive_folders(tenant_id,connection_id,purpose,google_folder_id,parent_folder_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,connection_id,purpose) DO UPDATE SET google_folder_id=excluded.google_folder_id,parent_folder_id=excluded.parent_folder_id",
            [x.session.active_tenant_id, c.id, purpose, f.id, c.root_folder_id],
          ),
        );
      }
      return { initialized: PURPOSES.length };
    } finally {
      await this.run(x, token, (q) =>
        q.query(
          "UPDATE inventory.tenant_drive_connections SET operation_lease_until=NULL WHERE id=$1",
          [c.id],
        ),
      );
    }
  }
  async revoke(token: string | undefined, input: unknown) {
    const { connectionId } = this.parse(
        z.object({ connectionId: z.uuid() }).strict(),
        input,
      ),
      x = await this.scope(token),
      c = await this.connection(x, token, connectionId);
    // Local disable commits first; remote revocation failure must not reactivate the connection.
    await this.run(x, token, async (q) => {
      await q.query("SELECT inventory_security.drive_admin_guard()");
      await q.query(
        "UPDATE inventory.tenant_drive_connections SET status='revoked',capabilities='{}' WHERE id=$1",
        [c.id],
      );
    });
    let remoteRevoked = c.auth_mode !== "oauth";
    if (c.auth_mode === "oauth" && c.token_ciphertext && c.encryption_key_id)
      try {
        await oauthClient(this.c).revokeToken(
          this.vault.open(
            c.token_ciphertext,
            c.encryption_key_id,
            `${x.session.active_tenant_id}:${c.id}:oauth`,
          ),
        );
        remoteRevoked = true;
      } catch {
        /* local access remains disabled */
      }
    return { disabled: true, remoteRevoked };
  }
  async start(token: string | undefined, input: unknown) {
    const b = this.parse(
      z
        .object({
          name: z.string(),
          mime: z.string(),
          size: z.number().int(),
          purpose: z.enum(PURPOSES),
          idempotencyKey: z.uuid(),
          sensitive: z.boolean().default(false),
        })
        .strict(),
      input,
    );
    validateFile(b.name, b.mime, b.size, this.c.maxBytes);
    const x = await this.scope(token, "files.upload"),
      c = await this.connection(x, token),
      p = this.port(x, c);
    const existing = await this.run(x, token, (q) =>
      q.query<{
        id: string;
        actor_id: string;
        original_filename: string;
        mime_type: string;
        file_size: string;
        sensitivity: string;
        purpose: string;
      }>(
        "SELECT o.id,o.actor_id,f.original_filename,f.mime_type,f.file_size,f.sensitivity,d.purpose FROM inventory.file_upload_operations o JOIN inventory.file_attachments f ON f.id=o.file_id AND f.tenant_id=o.tenant_id JOIN inventory.tenant_drive_folders d ON d.tenant_id=f.tenant_id AND d.id=f.folder_id WHERE o.idempotency_key=$1",
        [b.idempotencyKey],
      ),
    );
    if (existing.rows[0]) {
      const e = existing.rows[0];
      if (
        e.actor_id !== x.session.active_membership_id ||
        e.original_filename !== b.name ||
        e.mime_type !== b.mime ||
        Number(e.file_size) !== b.size ||
        e.purpose !== b.purpose ||
        e.sensitivity !== (b.sensitive ? "sensitive" : "normal")
      )
        fail("IDEMPOTENCY_CONFLICT", 409);
      return { operationId: e.id };
    }
    const folders = await this.run(x, token, (q) =>
      q.query<{ id: string; google_folder_id: string }>(
        "SELECT id,google_folder_id FROM inventory.tenant_drive_folders WHERE connection_id=$1 AND purpose=$2",
        [c.id, b.purpose],
      ),
    );
    const f = folders.rows[0];
    if (!f) fail("DRIVE_INITIALIZE_REQUIRED", 409);
    await this.verifyRoot(p, c);
    await assertDescendant(p, f.google_folder_id, c.root_folder_id);
    const googleId = await p.generateId(),
      fileId = randomUUID(),
      opId = randomUUID();
    await this.run(x, token, async (q) => {
      await q.query(
        "INSERT INTO inventory.file_attachments(id,tenant_id,connection_id,folder_id,google_file_id,original_filename,mime_type,file_size,sensitivity,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          fileId,
          x.session.active_tenant_id,
          c.id,
          f.id,
          googleId,
          b.name,
          b.mime,
          b.size,
          b.sensitive ? "sensitive" : "normal",
          x.session.active_membership_id,
        ],
      );
      await q.query(
        "INSERT INTO inventory.file_upload_operations(id,tenant_id,file_id,actor_id,idempotency_key,expected_size,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '24 hours')",
        [
          opId,
          x.session.active_tenant_id,
          fileId,
          x.session.active_membership_id,
          b.idempotencyKey,
          b.size,
        ],
      );
    });
    const uri = await p.start(
      googleId,
      b.name,
      f.google_folder_id,
      b.mime,
      b.size,
      {
        inventoryTenant: x.session.active_tenant_id!,
        inventoryFile: fileId,
        inventoryOperation: opId,
      },
    );
    const v = this.vault.seal(
      uri,
      `${x.session.active_tenant_id}:${opId}:upload`,
    );
    await this.run(x, token, (q) =>
      q.query(
        "UPDATE inventory.file_upload_operations SET resumable_uri_ciphertext=$2,encryption_key_id=$3,status='uploading' WHERE id=$1",
        [opId, v.ciphertext, v.keyId],
      ),
    );
    return { operationId: opId };
  }
  private async upload(x: Snapshot, t: string | undefined, id: string) {
    const r = await this.run(x, t, (q) =>
      q.query<Upload>(
        `SELECT o.*,f.google_file_id,f.original_filename,f.mime_type,f.connection_id,f.checksum,d.google_folder_id folder_google_id FROM inventory.file_upload_operations o JOIN inventory.file_attachments f ON f.tenant_id=o.tenant_id AND f.id=o.file_id JOIN inventory.tenant_drive_folders d ON d.tenant_id=f.tenant_id AND d.id=f.folder_id WHERE o.id=$1 AND o.actor_id=$2`,
        [id, x.session.active_membership_id],
      ),
    );
    if (!r.rows[0]) fail("FILE_NOT_FOUND", 404);
    return r.rows[0];
  }
  async chunk(
    token: string | undefined,
    id: string,
    offset: number,
    bytes: Uint8Array,
  ) {
    if (
      !z.uuid().safeParse(id).success ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      bytes.length < 1 ||
      bytes.length > CHUNK_SIZE
    )
      fail("INVALID_CHUNK", 400);
    const x = await this.scope(token, "files.upload"),
      o = await this.upload(x, token, id),
      total = Number(o.expected_size);
    if (o.status === "ready") return { offset: total, ready: true };
    if (new Date(o.expires_at).getTime() < Date.now())
      fail("UPLOAD_EXPIRED", 410);
    if (
      offset !== Number(o.confirmed_offset) ||
      offset + bytes.length > total ||
      offset % 262144 !== 0 ||
      (offset + bytes.length < total && bytes.length % 262144 !== 0)
    )
      fail("UPLOAD_OFFSET_CONFLICT", 409);
    if (offset === 0) verifyMagic(bytes, o.mime_type);
    if (offset > 0 && !o.first_chunk_verified)
      fail("UPLOAD_RECOVERY_REQUIRED", 409);
    const lease = secret(),
      claimed = await this.run(x, token, (q) =>
        q.query(
          "UPDATE inventory.file_upload_operations SET lease_token_digest=$2,lease_expires_at=clock_timestamp()+interval '2 minutes',first_chunk_verified=first_chunk_verified OR $3 WHERE id=$1 AND status='uploading' AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()) AND confirmed_offset=$4 RETURNING id",
          [id, digest(lease), offset === 0, offset],
        ),
      );
    if (!claimed.rows.length) fail("UPLOAD_BUSY", 409);
    const c = await this.connection(x, token, o.connection_id);
    if (c.status !== "ready") fail("DRIVE_RECONNECT_REQUIRED", 409);
    const p = this.port(x, c);
    await this.verifyRoot(p, c);
    await assertDescendant(p, o.folder_google_id, c.root_folder_id);
    if (!o.resumable_uri_ciphertext || !o.encryption_key_id)
      fail("UPLOAD_RECOVERY_REQUIRED", 409);
    const uri = this.vault.open(
      o.resumable_uri_ciphertext,
      o.encryption_key_id,
      `${x.session.active_tenant_id}:${id}:upload`,
    );
    // On ambiguous network failures keep the lease; reconcile with Google before sending more bytes.
    const r = await p.chunk(uri, bytes, offset, total);
    if (
      r.offset !== offset + bytes.length ||
      (r.fileId && r.fileId !== o.google_file_id)
    )
      fail("UPLOAD_OFFSET_CONFLICT", 409);
    await this.run(x, token, (q) =>
      q.query(
        "UPDATE inventory.file_upload_operations SET confirmed_offset=$3,status=$4,lease_expires_at=NULL,lease_token_digest=NULL WHERE id=$1 AND lease_token_digest=$2",
        [id, digest(lease), r.offset, r.fileId ? "verifying" : "uploading"],
      ),
    );
    return { offset: r.offset, ready: false, needsVerification: !!r.fileId };
  }
  async finish(token: string | undefined, input: unknown) {
    const { operationId, md5 } = this.parse(
        z
          .object({
            operationId: z.uuid(),
            md5: z.string().regex(/^[a-f0-9]{32}$/),
          })
          .strict(),
        input,
      ),
      x = await this.scope(token, "files.upload"),
      o = await this.upload(x, token, operationId),
      c = await this.connection(x, token, o.connection_id);
    if (c.status !== "ready") fail("DRIVE_RECONNECT_REQUIRED", 409);
    if (o.status === "ready") {
      if (o.checksum !== md5) fail("CHECKSUM_MISMATCH", 409);
      return { ready: true, fileId: o.file_id };
    }
    if (
      !o.first_chunk_verified ||
      Number(o.confirmed_offset) !== Number(o.expected_size) ||
      o.status !== "verifying"
    )
      fail("UPLOAD_INCOMPLETE", 409);
    const p = this.port(x, c);
    await this.verifyRoot(p, c);
    const f = await p.get(o.google_file_id);
    await assertDescendant(p, f.id, c.root_folder_id);
    if (
      f.id !== o.google_file_id ||
      f.mimeType !== o.mime_type ||
      f.size !== String(o.expected_size) ||
      f.md5Checksum !== md5 ||
      f.parents?.length !== 1 ||
      f.parents[0] !== o.folder_google_id ||
      f.appProperties?.inventoryFile !== o.file_id ||
      f.appProperties?.inventoryTenant !== x.session.active_tenant_id
    )
      fail("DRIVE_VERIFICATION_FAILED", 409);
    await this.run(x, token, async (q) => {
      await q.query(
        "UPDATE inventory.file_attachments SET status='ready',checksum=$2 WHERE id=$1",
        [o.file_id, md5],
      );
      await q.query(
        "UPDATE inventory.file_upload_operations SET status='ready',resumable_uri_ciphertext=NULL,encryption_key_id=NULL WHERE id=$1",
        [o.id],
      );
    });
    return { ready: true, fileId: o.file_id };
  }
  async recover(token: string | undefined, input: unknown) {
    const { operationId } = this.parse(
        z.object({ operationId: z.uuid() }).strict(),
        input,
      ),
      x = await this.scope(token, "files.upload"),
      o = await this.upload(x, token, operationId);
    if (o.status === "ready")
      return { offset: Number(o.expected_size), status: o.status };
    if (new Date(o.expires_at).getTime() < Date.now())
      fail("UPLOAD_EXPIRED", 410);
    const c = await this.connection(x, token, o.connection_id);
    if (c.status !== "ready") fail("DRIVE_RECONNECT_REQUIRED", 409);
    const p = this.port(x, c);
    await this.verifyRoot(p, c);
    const lease = secret(),
      claim = await this.run(x, token, (q) =>
        q.query(
          "UPDATE inventory.file_upload_operations SET lease_token_digest=$2,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()) RETURNING id",
          [o.id, digest(lease)],
        ),
      );
    if (!claim.rows.length) fail("UPLOAD_BUSY", 409);
    if (!o.resumable_uri_ciphertext || !o.encryption_key_id) {
      if (Number(o.confirmed_offset) !== 0)
        fail("UPLOAD_RECOVERY_REQUIRED", 409);
      await assertDescendant(p, o.folder_google_id, c.root_folder_id);
      const uri = await p.start(
        o.google_file_id,
        o.original_filename,
        o.folder_google_id,
        o.mime_type,
        Number(o.expected_size),
        {
          inventoryTenant: x.session.active_tenant_id!,
          inventoryFile: o.file_id,
          inventoryOperation: o.id,
        },
      );
      const v = this.vault.seal(
        uri,
        `${x.session.active_tenant_id}:${o.id}:upload`,
      );
      await this.run(x, token, (q) =>
        q.query(
          "UPDATE inventory.file_upload_operations SET resumable_uri_ciphertext=$3,encryption_key_id=$4,status='uploading',lease_expires_at=NULL,lease_token_digest=NULL WHERE id=$1 AND lease_token_digest=$2",
          [o.id, digest(lease), v.ciphertext, v.keyId],
        ),
      );
      return { offset: 0, status: "uploading" };
    }
    const r = await p.status(
      this.vault.open(
        o.resumable_uri_ciphertext,
        o.encryption_key_id,
        `${x.session.active_tenant_id}:${o.id}:upload`,
      ),
      Number(o.expected_size),
    );
    if (
      (r.fileId && r.fileId !== o.google_file_id) ||
      (r.offset > 0 && !o.first_chunk_verified)
    )
      fail("UPLOAD_RECOVERY_REQUIRED", 409);
    await this.run(x, token, (q) =>
      q.query(
        "UPDATE inventory.file_upload_operations SET confirmed_offset=$3,status=$4,lease_expires_at=NULL,lease_token_digest=NULL WHERE id=$1 AND lease_token_digest=$2",
        [o.id, digest(lease), r.offset, r.fileId ? "verifying" : "uploading"],
      ),
    );
    return { offset: r.offset, status: r.fileId ? "verifying" : "uploading" };
  }
  async download(
    token: string | undefined,
    id: string,
    start: number,
    end: number,
    preview = false,
  ) {
    if (
      !z.uuid().safeParse(id).success ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end - start + 1 > CHUNK_SIZE
    )
      fail("INVALID_RANGE", 400);
    const x = await this.scope(token, "files.download"),
      r = await this.run(x, token, (q) =>
        q.query<{
          connection_id: string;
          google_file_id: string;
          original_filename: string;
          mime_type: string;
          file_size: string;
          sensitivity: string;
          checksum: string;
        }>(
          "SELECT * FROM inventory.file_attachments WHERE id=$1 AND status='ready'",
          [id],
        ),
      ),
      f = r.rows[0];
    if (!f || end >= Number(f.file_size)) fail("FILE_NOT_FOUND", 404);
    if (f.sensitivity === "sensitive") {
      await this.scope(token, "files.sensitive.download");
      this.scopes.set(x, "files.sensitive.download");
    }
    const c = await this.connection(x, token, f.connection_id);
    if (c.status !== "ready" && c.status !== "retired")
      fail("DRIVE_RECONNECT_REQUIRED", 409);
    const p = this.port(x, c);
    await this.verifyRoot(p, c);
    await assertDescendant(p, f.google_file_id, c.root_folder_id);
    const meta = await p.get(f.google_file_id);
    if (
      meta.size !== String(f.file_size) ||
      meta.md5Checksum !== f.checksum ||
      meta.mimeType !== f.mime_type
    )
      fail("FILE_CHANGED", 409);
    const bytes = await p.read(f.google_file_id, start, end);
    await this.run(x, token, (q) =>
      q.query(
        "INSERT INTO inventory.file_access_logs(tenant_id,file_id,actor_id,action,correlation_id) VALUES($1,$2,$3,$4,$5)",
        [
          x.session.active_tenant_id,
          id,
          x.session.active_membership_id,
          preview ? "preview" : "download",
          randomUUID(),
        ],
      ),
    );
    return {
      bytes,
      name: f.original_filename,
      mime: f.mime_type,
      size: Number(f.file_size),
    };
  }
  async archive(token: string | undefined, input: unknown) {
    const { fileId } = this.parse(
        z.object({ fileId: z.uuid() }).strict(),
        input,
      ),
      x = await this.scope(token);
    await this.run(x, token, async (q) => {
      const r = await q.query(
        "UPDATE inventory.file_attachments SET status='archived' WHERE id=$1 RETURNING id",
        [fileId],
      );
      if (!r.rows.length) fail("FILE_NOT_FOUND", 404);
      await q.query(
        "INSERT INTO inventory.file_access_logs(tenant_id,file_id,actor_id,action,correlation_id) VALUES($1,$2,$3,'archive',$4)",
        [
          x.session.active_tenant_id,
          fileId,
          x.session.active_membership_id,
          randomUUID(),
        ],
      );
    });
    return { archived: true };
  }
  async rotate(token: string | undefined) {
    const x = await this.scope(token);
    let rotated = 0;
    await this.run(x, token, async (q) => {
      await q.query("SELECT inventory_security.drive_admin_guard()");
      const connections = await q.query<Connection>(
        "SELECT * FROM inventory.tenant_drive_connections WHERE token_ciphertext IS NOT NULL FOR UPDATE",
      );
      for (const c of connections.rows) {
        const aad = `${x.session.active_tenant_id}:${c.id}:oauth`,
          v = this.vault.seal(
            this.vault.open(c.token_ciphertext!, c.encryption_key_id!, aad),
            aad,
          );
        await q.query(
          "UPDATE inventory.tenant_drive_connections SET token_ciphertext=$2,encryption_key_id=$3 WHERE id=$1",
          [c.id, v.ciphertext, v.keyId],
        );
        rotated++;
      }
      const ops = await q.query<Upload>(
        "SELECT * FROM inventory.file_upload_operations WHERE resumable_uri_ciphertext IS NOT NULL FOR UPDATE",
      );
      for (const o of ops.rows) {
        const aad = `${x.session.active_tenant_id}:${o.id}:upload`,
          v = this.vault.seal(
            this.vault.open(
              o.resumable_uri_ciphertext!,
              o.encryption_key_id!,
              aad,
            ),
            aad,
          );
        await q.query(
          "UPDATE inventory.file_upload_operations SET resumable_uri_ciphertext=$2,encryption_key_id=$3 WHERE id=$1",
          [o.id, v.ciphertext, v.keyId],
        );
        rotated++;
      }
    });
    return { rotated };
  }
  async reconcile(token: string | undefined) {
    const x = await this.scope(token);
    let missing = 0,
      changed = 0,
      checked = 0,
      cleaned = 0,
      orphans = 0;
    const files = await this.run(x, token, (q) =>
      q.query<{
        id: string;
        connection_id: string;
        google_file_id: string;
        mime_type: string;
        file_size: string;
        checksum: string;
      }>(
        "SELECT id,connection_id,google_file_id,mime_type,file_size,checksum FROM inventory.file_attachments WHERE status IN ('ready','missing','quarantined') ORDER BY updated_at LIMIT 50",
      ),
    );
    for (const f of files.rows) {
      const c = await this.connection(x, token, f.connection_id);
      if (!["ready", "retired"].includes(c.status)) continue;
      try {
        const p = this.port(x, c);
        await this.verifyRoot(p, c);
        await assertDescendant(p, f.google_file_id, c.root_folder_id);
        const m = await p.get(f.google_file_id);
        const intact =
          m.size === String(f.file_size) &&
          m.mimeType === f.mime_type &&
          m.md5Checksum === f.checksum &&
          m.appProperties?.inventoryFile === f.id &&
          m.appProperties?.inventoryTenant === x.session.active_tenant_id;
        await this.run(x, token, (q) =>
          q.query(
            "UPDATE inventory.file_attachments SET status=$2 WHERE id=$1",
            [f.id, intact ? "ready" : "quarantined"],
          ),
        );
        checked++;
        if (!intact) changed++;
      } catch (e) {
        if (e instanceof AppError && e.code === "DRIVE_ACCESS_DENIED") {
          await this.run(x, token, (q) =>
            q.query(
              "UPDATE inventory.file_attachments SET status='missing' WHERE id=$1",
              [f.id],
            ),
          );
          missing++;
        } else throw e;
      }
    }
    const jobs = await this.run(x, token, (q) =>
      q.query<{
        id: string;
        payload: { connectionId: string; googleId: string };
      }>(
        "SELECT id,payload FROM inventory.outbox_jobs WHERE job_type='drive_probe_cleanup' AND status IN ('pending','failed') AND attempts<max_attempts ORDER BY created_at LIMIT 30",
      ),
    );
    for (const j of jobs.rows)
      try {
        const c = await this.connection(x, token, j.payload.connectionId),
          p = this.port(x, c),
          m = await p.get(j.payload.googleId);
        if (!m.trashed) {
          if (!m.appProperties?.inventoryProbe)
            fail("CLEANUP_MARKER_MISSING", 409);
          await assertDescendant(p, m.id, c.root_folder_id);
          await p.trash(m.id);
        }
        await this.run(x, token, (q) =>
          q.query(
            "UPDATE inventory.outbox_jobs SET status='done' WHERE id=$1",
            [j.id],
          ),
        );
        cleaned++;
      } catch {
        await this.run(x, token, (q) =>
          q.query(
            "UPDATE inventory.outbox_jobs SET status=CASE WHEN attempts+1>=max_attempts THEN 'dead' ELSE 'failed' END,attempts=attempts+1,last_error_code='DRIVE_CLEANUP_FAILED' WHERE id=$1",
            [j.id],
          ),
        );
      }
    const c = await this.connection(x, token).catch(() => null);
    if (c) {
      const p = this.port(x, c);
      await this.verifyRoot(p, c);
      const folders = await this.run(x, token, (q) =>
        q.query<{ google_folder_id: string }>(
          "SELECT google_folder_id FROM inventory.tenant_drive_folders WHERE connection_id=$1 ORDER BY purpose LIMIT 15",
          [c.id],
        ),
      );
      for (const folder of folders.rows) {
        await assertDescendant(p, folder.google_folder_id, c.root_folder_id);
        const candidates = await p.list(folder.google_folder_id, {
          inventoryTenant: x.session.active_tenant_id!,
        });
        for (const file of candidates) {
          const exists = await this.run(x, token, (q) =>
            q.query(
              "SELECT id FROM inventory.file_attachments WHERE google_file_id=$1",
              [file.id],
            ),
          );
          if (!exists.rows.length) orphans++;
        }
      }
    }
    await this.run(x, token, async (q) => {
      await q.query(
        "UPDATE inventory.file_upload_operations SET status='expired' WHERE status IN ('pending','uploading','failed') AND expires_at<clock_timestamp()",
      );
      await q.query(
        "UPDATE inventory.file_attachments f SET status='failed' FROM inventory.file_upload_operations o WHERE o.tenant_id=f.tenant_id AND o.file_id=f.id AND o.status='expired' AND f.status IN ('pending','uploading')",
      );
    });
    // Orphan evidence is recorded without deleting business files. Operator reviews retention first.
    await this.run(x, token, (q) =>
      q.query(
        "INSERT INTO inventory.outbox_jobs(tenant_id,job_type,payload,idempotency_key,status) VALUES($1,'drive_reconciliation_report',$2,$3,'done')",
        [
          x.session.active_tenant_id,
          JSON.stringify({ checked, missing, changed, cleaned, orphans }),
          randomUUID(),
        ],
      ),
    );
    return { checked, missing, changed, cleaned, orphans, limit: 50 };
  }
}
export function driveService(auth: AuthService) {
  const keyId = process.env.DRIVE_ACTIVE_KEY_ID,
    raw = process.env.DRIVE_ENCRYPTION_KEYS;
  if (!keyId || !raw) fail("DRIVE_NOT_CONFIGURED");
  const parsed: Record<string, string> = JSON.parse(raw),
    keys = Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, Buffer.from(v, "base64")]),
    );
  return new DriveService(auth, new Vault(keys, keyId), googleConfig());
}
