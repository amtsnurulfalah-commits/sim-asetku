import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { TestDatabase } from "./helpers/database";
import { SessionRepository } from "../src/lib/session/repository";
import { AuthService, type IdentityProvider } from "../src/lib/session/service";
import { AppError } from "../src/lib/security/errors";
import { DriveService } from "../src/features/drive/service";
import { DriveController } from "../src/features/drive/controller";
import {
  Vault,
  folderId,
  verifyMagic,
  validateFile,
  assertDescendant,
  probeConnection,
  FOLDER_MIME,
  type DriveFile,
  type DrivePort,
} from "../src/lib/drive/core";
import { GoogleDrive } from "../src/lib/drive/google";
import { cookieNames } from "../src/lib/security/http";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002",
  root = "RootFolderId123456";
const vault = new Vault({ v1: Buffer.alloc(32, 7) }, "v1");
class MemoryDrive implements DrivePort {
  files = new Map<string, DriveFile>([
    [
      root,
      {
        id: root,
        name: "Root",
        mimeType: FOLDER_MIME,
        driveId: "shared-test",
        parents: [],
        capabilities: { canAddChildren: true },
      },
    ],
  ]);
  buffers = new Map<string, Buffer>();
  sessions = new Map<string, { id: string; total: number }>();
  cleanupFail = false;
  listFail = false;
  chunkFail = false;
  afterChunk?: () => Promise<void>;
  startFail = false;
  async get(id: string) {
    const f = this.files.get(id);
    if (!f) throw new AppError("DRIVE_ACCESS_DENIED", 403, "Test missing");
    return structuredClone(f);
  }
  async list(parent: string, props: Record<string, string> = {}) {
    if (this.listFail) throw new Error("Test list failure");
    return [...this.files.values()]
      .filter(
        (f) =>
          !f.trashed &&
          f.parents?.includes(parent) &&
          Object.entries(props).every(([k, v]) => f.appProperties?.[k] === v),
      )
      .map((f) => structuredClone(f));
  }
  async folder(
    name: string,
    parent: string,
    appProperties: Record<string, string>,
  ) {
    const f = {
      id: randomUUID(),
      name,
      mimeType: FOLDER_MIME,
      parents: [parent],
      driveId: "shared",
      appProperties,
      capabilities: { canAddChildren: true },
    };
    this.files.set(f.id, f);
    return structuredClone(f);
  }
  async probe(parent: string, marker: string) {
    const f = {
      id: randomUUID(),
      name: "test.txt",
      mimeType: "text/plain",
      parents: [parent],
      appProperties: { inventoryProbe: marker },
    };
    this.files.set(f.id, f);
    return f;
  }
  async trash(id: string) {
    if (this.cleanupFail) throw new Error("Test cleanup failure");
    this.files.get(id)!.trashed = true;
  }
  async generateId() {
    return randomUUID();
  }
  async start(
    id: string,
    name: string,
    parent: string,
    mime: string,
    total: number,
    appProperties: Record<string, string>,
  ) {
    if (this.startFail) throw new Error("Test start response lost");
    this.files.set(id, {
      id,
      name,
      mimeType: mime,
      parents: [parent],
      appProperties,
      size: "0",
    });
    this.buffers.set(id, Buffer.alloc(0));
    const uri =
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=" + id;
    this.sessions.set(uri, { id, total });
    return uri;
  }
  async chunk(uri: string, bytes: Uint8Array, offset: number, total: number) {
    const s = this.sessions.get(uri)!;
    const old = this.buffers.get(s.id)!;
    assert.equal(old.length, offset);
    const b = Buffer.concat([old, bytes]);
    this.buffers.set(s.id, b);
    const f = this.files.get(s.id)!;
    f.size = String(b.length);
    f.md5Checksum = createHash("md5").update(b).digest("hex");
    if (this.chunkFail)
      throw new Error("Test network loss after Google accepted bytes");
    await this.afterChunk?.();
    return {
      offset: b.length,
      ...(b.length === total ? { fileId: s.id } : {}),
    };
  }
  async status(uri: string, total: number) {
    const s = this.sessions.get(uri)!,
      offset = this.buffers.get(s.id)!.length;
    return { offset, ...(offset === total ? { fileId: s.id } : {}) };
  }
  async read(id: string, start: number, end: number) {
    return this.buffers.get(id)!.subarray(start, end + 1);
  }
}
for (const v of [
  root,
  "https://drive.google.com/drive/folders/" + root,
  "https://drive.google.com/drive/u/0/folders/" + root + "?usp=sharing",
])
  test("Folder accepted: " + v, () => assert.equal(folderId(v), root));
for (const v of [
  "https://evil.example/drive/folders/" + root,
  "https://drive.google.com/file/d/" + root + "/view",
  "javascript:alert(1)",
  "short",
])
  test("Folder rejected: " + v, () => assert.throws(() => folderId(v)));
test("AES-GCM random nonce and round trip", () => {
  const a = vault.seal("refresh-token", "a:oauth"),
    b = vault.seal("refresh-token", "a:oauth");
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(vault.open(a.ciphertext, a.keyId, "a:oauth"), "refresh-token");
});
test("AES-GCM binds tenant/purpose and rejects corruption", () => {
  const a = vault.seal("secret", "a:oauth");
  assert.throws(() => vault.open(a.ciphertext, a.keyId, "b:oauth"));
  assert.throws(() => vault.open(a.ciphertext, a.keyId, "a:upload"));
  assert.throws(() => vault.open(a.ciphertext, "retired", "a:oauth"));
  const b = Buffer.from(a.ciphertext, "base64url");
  b[15] ^= 1;
  assert.throws(() => vault.open(b.toString("base64url"), a.keyId, "a:oauth"));
});
test("Whitelist rejects executable, SVG, path, mismatch and oversize", () => {
  for (const [n, m, s] of [
    ["x.exe", "application/octet-stream", 1],
    ["x.svg", "image/svg+xml", 1],
    ["../x.pdf", "application/pdf", 1],
    ["x.png", "application/pdf", 1],
    ["x.pdf", "application/pdf", 1025],
  ] as const)
    assert.throws(() => validateFile(n, m, s, 1024));
});
test("Magic bytes reject HTML masquerading as PDF", () => {
  verifyMagic(Buffer.from("%PDF-1.7"), "application/pdf");
  assert.throws(() => verifyMagic(Buffer.from("<script>"), "application/pdf"));
});
test("Ancestry blocks moved files, shortcuts and cycles", async () => {
  const p = new MemoryDrive();
  p.files.set("file", {
    id: "file",
    name: "x",
    mimeType: "application/pdf",
    parents: [root],
  });
  await assertDescendant(p, "file", root);
  p.files.get("file")!.parents = ["other"];
  await assert.rejects(() => assertDescendant(p, "file", root));
  p.files.set("other", {
    id: "other",
    name: "x",
    mimeType: FOLDER_MIME,
    parents: ["file"],
  });
  await assert.rejects(() => assertDescendant(p, "file", root));
  p.files.get("file")!.mimeType = "application/vnd.google-apps.shortcut";
  p.files.get("file")!.parents = [root];
  await assert.rejects(() => assertDescendant(p, "file", root));
});
test("Probe cleanup and list denial cannot report ready", async () => {
  const p = new MemoryDrive();
  p.cleanupFail = true;
  const r = await probeConnection(p, root, true, async () => {});
  assert.equal(r.ready, false);
  assert.equal(r.capabilities.cleanup, false);
  p.listFail = true;
  assert.equal(
    (await probeConnection(p, root, true, async () => {})).ready,
    false,
  );
});
test("Service account rejects My Drive", async () => {
  const p = new MemoryDrive();
  delete p.files.get(root)!.driveId;
  assert.equal(
    (await probeConnection(p, root, true, async () => {})).ready,
    false,
  );
});
test("Adapter refuses foreign resumable endpoint before network", async () => {
  let requests = 0;
  const p = new GoogleDrive(
    async () => "test",
    async () => {
      requests++;
      return new Response();
    },
  );
  await assert.rejects(() =>
    p.status("https://evil.example/upload?upload_id=x", 1),
  );
  assert.equal(requests, 0);
});
test("Adapter sends Shared Drive support and server bearer", async () => {
  let url = "";
  const p = new GoogleDrive(
    async () => "test-server-only",
    async (u, init) => {
      url = String(u);
      assert.equal(
        (init!.headers as Record<string, string>).Authorization,
        "Bearer test-server-only",
      );
      return Response.json({ id: root });
    },
  );
  await p.get(root);
  assert.match(url, /supportsAllDrives=true/);
});
const db = new TestDatabase();
let service: DriveService, auth: AuthService, token: string, p: MemoryDrive;
let identityId = "test_admin_a";
const identity: IdentityProvider = {
  async authenticate(username) {
    return {
      sso_user_id: identityId,
      username,
      full_name: "Admin",
      account_status: "active",
      identity_version: 1,
      authenticated_at: new Date().toISOString(),
      request_id: "drive-test",
    };
  },
  async getUserStatus(id) {
    return {
      sso_user_id: id,
      account_status: "active",
      is_archived: false,
      can_authenticate: true,
      identity_version: 1,
      checked_at: new Date().toISOString(),
      request_id: "drive-test",
    };
  },
};
before(async () => db.init());
after(async () => db.close());
beforeEach(async () => {
  await db.pg.exec(
    "DELETE FROM inventory.app_sessions; DELETE FROM inventory.sso_status_cache; DELETE FROM inventory.login_rate_limits; UPDATE inventory.tenant_drive_connections SET status='retired',operation_lease_until=NULL;",
  );
  identityId = "test_admin_a";
  auth = new AuthService(
    new SessionRepository(db),
    identity,
    "test-drive-rate-secret-public-only",
  );
  const login = await auth.login({
    username: "admin.a",
    password: "test-only",
  });
  token = login.token;
  const switched = await auth.switchTenant(token, A);
  token = switched.token;
  p = new MemoryDrive();
  service = new DriveService(
    auth,
    vault,
    {
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "https://app.example/api/drive/oauth/callback",
      maxBytes: 20971520,
    },
    () => p,
  );
});
async function connect() {
  assert.equal((await service.configure(token, { folder: root })).ready, true);
  await service.initialize(token);
}
const bytes = Buffer.from("%PDF-1.7\nTest document"),
  md5 = createHash("md5").update(bytes).digest("hex");
async function start() {
  return service.start(token, {
    name: "test.pdf",
    mime: "application/pdf",
    size: bytes.length,
    purpose: "Dokumen-Lainnya",
    idempotencyKey: randomUUID(),
  });
}
test("Connection success requires probe and DTO contains no secrets", async () => {
  assert.equal((await service.configure(token, { folder: root })).ready, true);
  const d = await service.data(token);
  assert.equal(d.connections[0].status, "ready");
  assert.ok(!JSON.stringify(d).includes("ciphertext"));
});
test("Cleanup failure persists failed connection", async () => {
  p.cleanupFail = true;
  assert.equal((await service.configure(token, { folder: root })).ready, false);
  assert.equal((await service.data(token)).connections[0].status, "failed");
});
test("Fifteen folders initialize idempotently", async () => {
  await connect();
  const n = p.files.size;
  await service.initialize(token);
  assert.equal(p.files.size, n);
});
test("Upload ready requires correct checksum, then private download works", async () => {
  await connect();
  const { operationId } = await start();
  await assert.rejects(() => service.finish(token, { operationId, md5 }));
  await service.chunk(token, operationId, 0, bytes);
  await assert.rejects(() =>
    service.finish(token, { operationId, md5: "0".repeat(32) }),
  );
  await service.finish(token, { operationId, md5 });
  const f = (await service.data(token)).files[0];
  assert.equal(f.status, "ready");
  assert.deepEqual(
    Buffer.from(
      (await service.download(token, f.id, 0, bytes.length - 1)).bytes,
    ),
    bytes,
  );
});
test("Bad signature and moved Google parent deny completion", async () => {
  await connect();
  const { operationId } = await start();
  await assert.rejects(() =>
    service.chunk(token, operationId, 0, Buffer.alloc(bytes.length, 60)),
  );
  await service.chunk(token, operationId, 0, bytes);
  [...p.files.values()].find(
    (f) => f.appProperties?.inventoryOperation === operationId,
  )!.parents = ["foreign-root"];
  await assert.rejects(() => service.finish(token, { operationId, md5 }));
});
test("Lost response recovers Google offset after lease expires", async () => {
  await connect();
  const { operationId } = await start();
  p.chunkFail = true;
  await assert.rejects(() => service.chunk(token, operationId, 0, bytes));
  await assert.rejects(() => service.recover(token, { operationId }));
  await db.pg.query(
    "UPDATE inventory.file_upload_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [operationId],
  );
  const r = await service.recover(token, { operationId });
  assert.equal(r.offset, bytes.length);
  assert.equal(r.status, "verifying");
  await service.finish(token, { operationId, md5 });
});
test("Idempotency reuses operation and rejects altered payload", async () => {
  await connect();
  const b = {
    name: "test.pdf",
    mime: "application/pdf",
    size: bytes.length,
    purpose: "Dokumen-Lainnya",
    idempotencyKey: randomUUID(),
  };
  const a = await service.start(token, b),
    c = await service.start(token, b);
  assert.equal(a.operationId, c.operationId);
  await assert.rejects(() => service.start(token, { ...b, size: 99 }));
});
test("Tenant B cannot read tenant A metadata", async () => {
  await connect();
  const { operationId } = await start();
  const rows = await db.run("runtime", { tenantId: B }, (q) =>
    q.query("SELECT id FROM inventory.file_upload_operations WHERE id=$1", [
      operationId,
    ]),
  );
  assert.equal(rows.rows.length, 0);
  await assert.rejects(() =>
    service.recover(token, { operationId: randomUUID() }),
  );
});
test("OAuth state encrypted and replay denied", async () => {
  const r = await service.oauthStart(token, { folder: root }),
    u = new URL(r.url);
  assert.equal(u.origin, "https://accounts.google.com");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  const state = u.searchParams.get("state")!,
    hash = createHash("sha256").update(state).digest("hex");
  const rows = (
    await db.pg.query<{ verifier_ciphertext: string }>(
      "SELECT verifier_ciphertext FROM inventory.drive_oauth_states WHERE state_digest=$1",
      [hash],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.ok(!r.url.includes(rows[0].verifier_ciphertext));
  await db.pg.query(
    "UPDATE inventory.drive_oauth_states SET consumed_at=clock_timestamp() WHERE state_digest=$1",
    [hash],
  );
  await assert.rejects(() => service.oauthCallback(token, state, "code"));
});
test("Stale tenant header and absent CSRF rejected", async () => {
  const controller = new DriveController(service, "https://app.example"),
    n = cookieNames("https://app.example"),
    headers = { Cookie: `${n.session}=${token}` };
  assert.equal(
    (
      await controller.handle(
        "data",
        new Request("https://app.example/api/drive/data", {
          headers: { ...headers, "X-Tenant-Context": B },
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await controller.handle(
        "configure",
        new Request("https://app.example/api/drive/configure", {
          method: "POST",
          headers: {
            ...headers,
            "X-Tenant-Context": A,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ folder: root }),
        }),
      )
    ).status,
    403,
  );
});
test("Archive preserves Google bytes and blocks download", async () => {
  await connect();
  const { operationId } = await start();
  await service.chunk(token, operationId, 0, bytes);
  await service.finish(token, { operationId, md5 });
  const f = (await service.data(token)).files[0];
  await service.archive(token, { fileId: f.id });
  assert.equal(p.buffers.size, 1);
  await assert.rejects(() =>
    service.download(token, f.id, 0, bytes.length - 1),
  );
});
test("Revocation blocks previous uploads", async () => {
  await connect();
  const { operationId } = await start();
  await service.chunk(token, operationId, 0, bytes);
  await service.finish(token, { operationId, md5 });
  const d = await service.data(token);
  await service.revoke(token, { connectionId: d.connections[0].id });
  await assert.rejects(() =>
    service.download(token, d.files[0].id, 0, bytes.length - 1),
  );
});
test("Viewer cannot configure, upload, or see Drive secrets", async () => {
  identityId = "test_viewer";
  const login = await auth.login({
    username: "viewer.a",
    password: "test-only",
  });
  const t = (await auth.switchTenant(login.token, A)).token;
  await assert.rejects(() => service.configure(t, { folder: root }));
  await assert.rejects(() => service.data(t));
  await assert.rejects(() =>
    service.start(t, {
      name: "x.pdf",
      mime: "application/pdf",
      size: 10,
      purpose: "Dokumen-Lainnya",
      idempotencyKey: randomUUID(),
    }),
  );
  assert.equal(p.files.size, 1);
});
test("Tenant roots cannot overlap another tenant reservation", async () => {
  await connect();
  identityId = "test_admin_b";
  const login = await auth.login({
    username: "admin.b",
    password: "test-only",
  });
  const t = (await auth.switchTenant(login.token, B)).token;
  const child = "AnotherRootId123456";
  p.files.set(child, {
    id: child,
    name: "Child",
    mimeType: FOLDER_MIME,
    driveId: "shared",
    parents: [root],
    capabilities: { canAddChildren: true },
  });
  await assert.rejects(() => service.configure(t, { folder: child }));
});
test("OAuth callback from another session cannot consume original state", async () => {
  const r = await service.oauthStart(token, { folder: root }),
    state = new URL(r.url).searchParams.get("state")!;
  const login = await auth.login({
      username: "admin.a",
      password: "test-only",
    }),
    t = (await auth.switchTenant(login.token, A)).token;
  await assert.rejects(() =>
    service.oauthCallback(t, state, "test-code-must-not-reach-Google"),
  );
  const row = (
    await db.pg.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM inventory.drive_oauth_states WHERE state_digest=$1",
      [createHash("sha256").update(state).digest("hex")],
    )
  ).rows[0];
  assert.equal(row.consumed_at, null);
});
test("Pending upload without resumable URI can recover", async () => {
  await connect();
  p.startFail = true;
  await assert.rejects(() => start());
  p.startFail = false;
  const op = (
    await db.pg.query<{ id: string }>(
      "SELECT id FROM inventory.file_upload_operations ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0].id;
  assert.equal((await service.recover(token, { operationId: op })).offset, 0);
  await service.chunk(token, op, 0, bytes);
  await service.finish(token, { operationId: op, md5 });
});
test("Moving tenant root requires new connection test", async () => {
  await connect();
  p.files.set("MovedParent", {
    id: "MovedParent",
    name: "Moved",
    mimeType: FOLDER_MIME,
    parents: [],
  });
  p.files.get(root)!.parents = ["MovedParent"];
  await assert.rejects(() => start());
});
test("Reconciliation marks missing files and restores verified metadata", async () => {
  await connect();
  const { operationId } = await start();
  await service.chunk(token, operationId, 0, bytes);
  await service.finish(token, { operationId, md5 });
  const f = [...p.files.values()].find(
    (f) => f.appProperties?.inventoryOperation === operationId,
  )!;
  p.files.delete(f.id);
  assert.ok((await service.reconcile(token)).missing >= 1);
  p.files.set(f.id, f);
  await service.reconcile(token);
  assert.equal((await service.data(token)).files[0].status, "ready");
});
test("Reconciliation detects unregistered file without deleting it", async () => {
  await connect();
  const folder = [...p.files.values()].find(
    (f) => f.appProperties?.inventoryPurpose === "Dokumen-Lainnya",
  )!;
  const orphan = {
    id: "OrphanId123456",
    name: "orphan.pdf",
    mimeType: "application/pdf",
    parents: [folder.id],
    appProperties: { inventoryTenant: A, inventoryFile: randomUUID() },
  };
  p.files.set(orphan.id, orphan);
  assert.equal((await service.reconcile(token)).orphans, 1);
  assert.equal(p.files.get(orphan.id)?.trashed, undefined);
});
test("Quota errors are classified without leaking Google response", async () => {
  const adapter = new GoogleDrive(
    async () => "test",
    async () =>
      Response.json(
        {
          error: {
            errors: [{ reason: "storageQuotaExceeded" }],
            message: "private-account-detail",
          },
        },
        { status: 403 },
      ),
  );
  await assert.rejects(
    () => adapter.get(root),
    (e: unknown) =>
      e instanceof AppError &&
      e.code === "DRIVE_RATE_LIMIT" &&
      !e.message.includes("private-account-detail"),
  );
});
test("Session revocation during Google upload blocks metadata commit", async () => {
  await connect();
  const { operationId } = await start();
  p.afterChunk = async () => {
    await db.pg.exec(
      "UPDATE inventory.app_sessions SET revoked_at=clock_timestamp()",
    );
  };
  await assert.rejects(() => service.chunk(token, operationId, 0, bytes));
  const o = (
    await db.pg.query<{ status: string; confirmed_offset: number }>(
      "SELECT status,confirmed_offset FROM inventory.file_upload_operations WHERE id=$1",
      [operationId],
    )
  ).rows[0];
  assert.equal(o.status, "uploading");
  assert.equal(Number(o.confirmed_offset), 0);
});
