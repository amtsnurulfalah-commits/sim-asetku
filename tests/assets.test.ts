import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { TestDatabase } from "./helpers/database";
import { SessionRepository } from "../src/lib/session/repository";
import {
  AuthService,
  tokenDigest,
  type IdentityProvider,
} from "../src/lib/session/service";
import { AssetService } from "../src/features/assets/service";
import { AssetController } from "../src/features/assets/controller";
import { assetUrl, parseScan } from "../src/features/assets/qr";
import { qrPng, labelPdf } from "../src/features/assets/labels";
import {
  assetInput,
  amount,
  type AssetInput,
  type Options,
} from "../src/features/assets/schemas";
import { cookieNames } from "../src/lib/security/http";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002",
  AS = "00000000-0000-4000-8000-000000000051";
const db = new TestDatabase();
let service: AssetService,
  auth: AuthService,
  token: string,
  identityId = "test_admin_a",
  options: Options;
const provider: IdentityProvider = {
  async authenticate(username) {
    return {
      sso_user_id: identityId,
      username,
      full_name: "Test",
      account_status: "active",
      identity_version: 1,
      authenticated_at: new Date().toISOString(),
      request_id: "asset-test",
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
      request_id: "asset-test",
    };
  },
};
before(async () => db.init());
after(async () => db.close());
beforeEach(async () => {
  await db.pg.exec(
    "DELETE FROM inventory.app_sessions;DELETE FROM inventory.sso_status_cache;DELETE FROM inventory.login_rate_limits;",
  );
  identityId = "test_admin_a";
  auth = new AuthService(
    new SessionRepository(db),
    provider,
    "test-assets-secret-public-only",
  );
  service = new AssetService(auth);
  const login = await auth.login({
    username: "test.admin.a",
    password: "test-only",
  });
  token = (await auth.switchTenant(login.token, A)).token;
  options = await service.options(token);
});
function base(kind = "equipment"): AssetInput {
  return {
    name: "Aset Uji " + randomUUID().slice(0, 8),
    category_id: options.refs.categories.find((c) => c.asset_kind === kind)!.id,
    subcategory_id: null,
    unit_id: options.refs.units.find((u) => u.code === "UNIT")!.id,
    funding_source_id: null,
    room_id: options.refs.rooms[0].id,
    responsible_membership_id: null,
    condition_id: options.refs.conditions.find((c) => c.code === "BAIK")!.id,
    lifecycle_status: "draft",
    brand: "",
    model: "",
    serial_number: "",
    specifications: "Spesifikasi pengujian",
    acquisition_date: "2026-01-01",
    in_service_date: null,
    acquisition_method: "Pembelian",
    acquisition_cost: "1000000.01",
    residual_value: "1.01",
    useful_life_months: null,
    depreciation_policy_id: null,
    notes: "",
    detail: { type: "general" },
    reason: "Pencatatan pengujian",
  };
}
const create = (asset = base(), count = 1, key = randomUUID()) =>
  service.create(token, { asset, count, idempotencyKey: key });
async function edit(id: string, change: (a: AssetInput) => void) {
  const d = await service.detail(token, id);
  const a = structuredClone(d.input);
  change(a);
  return service.update(token, {
    id,
    rowVersion: d.asset.row_version,
    asset: a,
  });
}
async function loginAs(id: string, tenant = A) {
  identityId = id;
  const login = await auth.login({
    username: "test." + id,
    password: "test-only",
  });
  return (await auth.switchTenant(login.token, tenant)).token;
}
test("Monetary input preserves decimal strings and rejects exponent/negative", () => {
  assert.ok(amount.safeParse("1234567890123456.99").success);
  for (const a of ["-1", "1e6", "1,000", "2.123"])
    assert.equal(amount.safeParse(a).success, false);
});
test("Strict DTO rejects tenant override and fake derived financial fields", () => {
  assert.equal(
    assetInput.safeParse({ ...base(), tenant_id: B }).success,
    false,
  );
  assert.equal(
    assetInput.safeParse({ ...base(), book_value: "0" }).success,
    false,
  );
});
test("Initial master data includes six conditions and active member options", async () => {
  assert.equal(options.refs.conditions.length, 6);
  assert.ok(options.members.some((m) => m.name));
  assert.equal(options.tenantId, A);
});
test("Admin creates, searches, updates and archives configurable master", async () => {
  const id = (
    await service.saveMaster(token, {
      kind: "units",
      id: null,
      rowVersion: null,
      data: {
        code: "TEST_" + randomUUID().slice(0, 6).toUpperCase(),
        name: "Satuan Khusus",
        status: "active",
      },
    })
  ).id as string;
  let r = await service.masters(token, {
    kind: "units",
    query: "Satuan Khusus",
  });
  const row = r.items.find((x) => x.id === id)!;
  await service.saveMaster(token, {
    kind: "units",
    id,
    rowVersion: row.row_version,
    data: { code: row.code, name: row.name, status: "archived" },
  });
  r = await service.masters(token, { kind: "units", query: row.code });
  assert.equal(r.items[0].status, "archived");
});
test("Master stale version rejected", async () => {
  const r = options.refs.units[0];
  await assert.rejects(() =>
    service.saveMaster(token, {
      kind: "units",
      id: r.id,
      rowVersion: "999999",
      data: { code: r.code, name: r.name, status: r.status },
    }),
  );
});
test("Viewer reads own assets but cannot create, configure, master or label export", async () => {
  const t = await loginAs("test_viewer");
  assert.ok((await service.list(t, {})).items.length);
  for (const fn of [
    () =>
      service.create(t, {
        asset: base(),
        count: 1,
        idempotencyKey: randomUUID(),
      }),
    () => service.options(t, true),
    () => service.configure(t, { format: "{number}", width: 70, height: 35 }),
    () => service.labelRows(t, { ids: [AS] }),
  ])
    await assert.rejects(fn);
});
test("Batch creates per-unit IDs and codes; exact replay creates no duplicates", async () => {
  const a = base(),
    key = randomUUID(),
    first = await create(a, 3, key),
    again = await create(a, 3, key);
  assert.equal(first.ids.length, 3);
  assert.equal(new Set(first.ids).size, 3);
  assert.equal(again.batchId, first.batchId);
  assert.equal(again.reused, true);
  const rows = await db.pg.query<{ inventory_code: string; public_id: string }>(
    "SELECT inventory_code,public_id FROM inventory.assets WHERE batch_id=$1",
    [first.batchId],
  );
  assert.equal(new Set(rows.rows.map((x) => x.inventory_code)).size, 3);
  assert.equal(new Set(rows.rows.map((x) => x.public_id)).size, 3);
  await assert.rejects(() => create({ ...a, name: "Altered" }, 3, key));
});
test("Serial number cannot be reused implicitly across a batch", async () => {
  await assert.rejects(() => create({ ...base(), serial_number: "SN-1" }, 2));
});
test("Configured numbering is atomic and existing codes remain unchanged", async () => {
  await service.configure(token, {
    format: "{tenant}-{year}-{number}",
    width: 70,
    height: 35,
  });
  const r = await create();
  const d = await service.detail(token, r.ids[0]);
  assert.match(d.asset.inventory_code, /^TEST_A-2026-\d{6,}$/);
  await service.configure(token, {
    format: "{tenant}/{category}/{year}/{number}",
    width: 70,
    height: 35,
  });
  assert.equal(
    (await service.detail(token, r.ids[0])).asset.inventory_code,
    d.asset.inventory_code,
  );
});
test("Invalid numbering without sequence or unsafe literals is rejected", async () => {
  for (const format of ["fixed", "{number}<script>", "{unknown}/{number}"])
    await assert.rejects(() =>
      service.configure(token, { format, width: 70, height: 35 }),
    );
});
test("Tenant B cannot read or mutate A asset through public or internal IDs", async () => {
  const r = await create(),
    d = await service.detail(token, r.ids[0]),
    t = await loginAs("test_admin_b", B);
  await assert.rejects(() => service.detail(t, r.ids[0]));
  await assert.rejects(() => service.detail(t, d.asset.public_id, true));
  await assert.rejects(() =>
    service.update(t, {
      id: r.ids[0],
      rowVersion: d.asset.row_version,
      asset: d.input,
    }),
  );
});
test("Cross-tenant or archived references rejected with no partial batch", async () => {
  const roomB = "00000000-0000-4000-8000-000000000042";
  await assert.rejects(() => create({ ...base(), room_id: roomB }, 3));
  const cond = options.refs.conditions[0];
  await db.pg.query(
    "UPDATE inventory.asset_conditions SET status='archived' WHERE id=$1",
    [cond.id],
  );
  await assert.rejects(() => create({ ...base(), condition_id: cond.id }));
  await db.pg.query(
    "UPDATE inventory.asset_conditions SET status='active' WHERE id=$1",
    [cond.id],
  );
});
test("Subcategory must belong to selected category", async () => {
  const a = base(),
    other = options.refs.categories.find((c) => c.id !== a.category_id)!;
  const sub = await service.saveMaster(token, {
    kind: "subcategories",
    id: null,
    rowVersion: null,
    data: {
      code: "SUB_" + randomUUID().slice(0, 6).toUpperCase(),
      name: "Sub Test",
      category_id: other.id,
      status: "active",
    },
  });
  await assert.rejects(() =>
    create({ ...a, subcategory_id: sub.id as string }),
  );
});
test("Exact financial calculation uses ledger; client cannot set accumulation", async () => {
  const r = await create(),
    d = await service.detail(token, r.ids[0]);
  assert.equal(d.asset.acquisition_cost, "1000000.01");
  assert.equal(d.asset.accumulated_depreciation, "0");
  assert.equal(d.asset.book_value, "1000000.01");
  await assert.rejects(() => create({ ...base(), residual_value: "2000000" }));
});
test("Land detail required, batch land works, depreciation forbidden", async () => {
  await assert.rejects(() => create(base("land")));
  const land: AssetInput = {
    ...base("land"),
    detail: {
      type: "land",
      data: {
        area_sqm: "123.4567",
        address: "Alamat pengujian",
        ownership_status: "Milik lembaga",
        certificate_number: "SERTIFIKAT-RAHASIA",
        rights_type: "Hak milik",
        land_use: "Sekolah",
      },
    },
  };
  const r = await create(land, 2);
  assert.equal(r.ids.length, 2);
  assert.equal(
    (await service.detail(token, r.ids[0])).detail.certificate_number,
    "SERTIFIKAT-RAHASIA",
  );
  await assert.rejects(() => create({ ...land, useful_life_months: 120 }));
});
test("Construction in progress cannot depreciate or enter service", async () => {
  const a: AssetInput = {
    ...base("building"),
    detail: {
      type: "building",
      data: {
        location_building_id: null,
        building_type: "Ruang belajar",
        construction_year: 2026,
        area_sqm: "100",
        floor_count: 1,
        construction_status: "in_progress",
        ownership_status: "Milik lembaga",
      },
    },
  };
  await create(a);
  await assert.rejects(() => create({ ...a, in_service_date: "2026-01-02" }));
  await assert.rejects(() => create({ ...a, useful_life_months: 240 }));
});
test("Vehicle sensitive data redacted for Viewer", async () => {
  const a: AssetInput = {
    ...base("vehicle"),
    detail: {
      type: "vehicle",
      data: {
        vehicle_type: "Mobil",
        manufacturing_year: 2020,
        registration_number: "B 1234 XX",
        chassis_number: "RANGKA-RAHASIA",
        engine_number: "MESIN-RAHASIA",
        ownership_document_number: "BPKB-RAHASIA",
        registration_expiry: "2027-01-01",
        next_service_date: "2026-12-01",
      },
    },
  };
  const r = await create(a),
    t = await loginAs("test_viewer"),
    d = await service.detail(t, r.ids[0]);
  assert.equal(d.canSeeSensitive, false);
  assert.ok(!JSON.stringify(d).includes("RAHASIA"));
});
test("Draft edits record location/condition history; stale version rejected", async () => {
  const r = await create(),
    d = await service.detail(token, r.ids[0]);
  await edit(r.ids[0], (a) => {
    a.condition_id = options.refs.conditions.find(
      (c) => c.code === "RUSAK_RINGAN",
    )!.id;
    a.room_id = null;
  });
  const updated = await service.detail(token, r.ids[0]);
  assert.equal(updated.history.lokasi.length, 2);
  assert.equal(updated.history.kondisi.length, 2);
  await assert.rejects(() =>
    service.update(token, {
      id: r.ids[0],
      rowVersion: d.asset.row_version,
      asset: d.input,
    }),
  );
});
test("Available asset location cannot bypass movement workflow", async () => {
  const r = await create({ ...base(), lifecycle_status: "available" });
  await assert.rejects(() =>
    edit(r.ids[0], (a) => {
      a.room_id = null;
    }),
  );
  await assert.rejects(() =>
    edit(r.ids[0], (a) => {
      a.lifecycle_status = "draft";
    }),
  );
});
test("Archive preserves histories and rejects repeat stale update", async () => {
  const r = await create(),
    d = await service.detail(token, r.ids[0]);
  await service.archive(token, {
    id: r.ids[0],
    rowVersion: d.asset.row_version,
    reason: "Pencatatan tidak digunakan",
  });
  const updated = await service.detail(token, r.ids[0]);
  assert.equal(updated.asset.lifecycle_status, "archived");
  assert.ok(updated.history.audit.length);
  await assert.rejects(() =>
    service.update(token, {
      id: r.ids[0],
      rowVersion: updated.asset.row_version,
      asset: d.input,
    }),
  );
});
test("Raw runtime writes to protected asset/master tables are denied", async () => {
  await assert.rejects(() =>
    db.run("runtime", { tenantId: A }, (q) =>
      q.query("UPDATE inventory.assets SET name='Injected' WHERE id=$1", [AS]),
    ),
  );
  await assert.rejects(() =>
    db.run("runtime", { tenantId: A }, (q) =>
      q.query(
        "INSERT INTO inventory.units(tenant_id,code,name) VALUES($1,'INJECT','Injected')",
        [A],
      ),
    ),
  );
});
test("Search filters and pagination bound result set", async () => {
  const r = await create({ ...base(), name: "Pagination Test" }, 23),
    page1 = await service.list(token, { query: "Pagination Test", page: 1 }),
    page2 = await service.list(token, { query: "Pagination Test", page: 2 });
  assert.equal(page1.total, 23);
  assert.equal(page1.items.length, 20);
  assert.equal(page2.items.length, 3);
  assert.equal(
    new Set([...page1.items, ...page2.items].map((a) => a.id)).size,
    r.ids.length,
  );
});
test("QR URL contains only public identifier and round-trips through independent decoder", async () => {
  const id = randomUUID(),
    png = PNG.sync.read(await qrPng("https://inventaris.example", id)),
    decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, assetUrl("https://inventaris.example", id));
  assert.ok(!decoded?.data.includes("token"));
});
test("Scanner rejects foreign origin, script and query token", () => {
  for (const value of [
    "javascript:alert(1)",
    "https://evil.example/aset/qr/" + randomUUID(),
    "https://inventaris.example/aset/qr/" + randomUUID() + "?token=secret",
  ])
    assert.throws(() => parseScan(value, "https://inventaris.example"));
  assert.deepEqual(
    parseScan("TEST_A/2026/000001", "https://inventaris.example"),
    { code: "TEST_A/2026/000001" },
  );
});
test("PDF labels paginate, preserve A4 and produce real printable artifact", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    public_id: randomUUID(),
    inventory_code: "TEST_A/ELEKTRONIK/2026/" + String(i + 1).padStart(6, "0"),
    name:
      i === 0
        ? "Proyektor Ruang Pembelajaran - Nama Aset Panjang untuk Uji Tata Letak"
        : "Komputer Pembelajaran " + (i + 1),
  }));
  const bytes = await labelPdf(
      {
        rows,
        tenantName: "Madrasah Pengujian - Contoh Label",
        width: 70,
        height: 35,
      },
      "https://inventaris.example",
    ),
    doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() > 1);
  assert.ok(Math.abs(doc.getPage(0).getWidth() - 595.2756) < 0.01);
  assert.ok(bytes.length < 4 * 1024 * 1024);
  await mkdir("tmp", { recursive: true });
  await writeFile("tmp/test-label.pdf", bytes);
});
test("Label selection refuses mixed tenant IDs and >100 filter matches", async () => {
  await assert.rejects(() =>
    service.labelRows(token, {
      ids: [AS, "00000000-0000-4000-8000-000000000052"],
    }),
  );
  await assert.rejects(() =>
    service.labelRows(token, {
      ids: Array.from({ length: 101 }, () => randomUUID()),
    }),
  );
});
test("Controller rejects stale browser tenant and missing CSRF", async () => {
  const controller = new AssetController(service, "https://app.example"),
    n = cookieNames("https://app.example"),
    headers = { Cookie: `${n.session}=${token}` };
  assert.equal(
    (
      await controller.handle(
        "list",
        new Request("https://app.example/api/assets/list", {
          headers: { ...headers, "X-Tenant-Context": B },
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await controller.handle(
        "create",
        new Request("https://app.example/api/assets/create", {
          method: "POST",
          headers: {
            ...headers,
            "X-Tenant-Context": A,
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      )
    ).status,
    403,
  );
});
test("Petugas edits preserve redacted ownership identifiers", async () => {
  const land: AssetInput = {
    ...base("land"),
    detail: {
      type: "land",
      data: {
        area_sqm: "100",
        address: "Alamat",
        ownership_status: "Milik",
        certificate_number: "SERTIFIKAT-PERTAHANKAN",
        rights_type: "Hak",
        land_use: "Sekolah",
      },
    },
  };
  const r = await create(land);
  const uid = randomUUID();
  await db.pg.query(
    "INSERT INTO inventory.app_users(id,sso_user_id,username_snapshot,full_name_snapshot) VALUES($1,'test_petugas','test.petugas','Petugas Uji')",
    [uid],
  );
  await db.pg.query(
    "INSERT INTO inventory.tenant_memberships(tenant_id,app_user_id,role_id) SELECT $1,$2,id FROM inventory.roles WHERE tenant_id=$1 AND code='petugas'",
    [A, uid],
  );
  const t = await loginAs("test_petugas"),
    d = await service.detail(t, r.ids[0]);
  assert.ok(!JSON.stringify(d).includes("SERTIFIKAT-PERTAHANKAN"));
  d.input.name = "Nama baru dari Petugas";
  await service.update(t, {
    id: r.ids[0],
    rowVersion: d.asset.row_version,
    asset: d.input,
  });
  const current = await service.detail(token, r.ids[0]);
  assert.equal(current.detail.certificate_number, "SERTIFIKAT-PERTAHANKAN");
  if (d.input.detail.type === "land")
    d.input.detail.data.certificate_number = "TIDAK-DIIZINKAN";
  await assert.rejects(() =>
    service.update(t, {
      id: r.ids[0],
      rowVersion: current.asset.row_version,
      asset: d.input,
    }),
  );
});
test("Acquisition dates and in-service order are validated", async () => {
  await assert.rejects(() =>
    create({ ...base(), acquisition_date: "2099-01-01" }),
  );
  await assert.rejects(() =>
    create({ ...base(), in_service_date: "2025-12-31" }),
  );
});
test("Used depreciation policy financial definition is immutable", async () => {
  const code = "POL_" + randomUUID().slice(0, 6).toUpperCase(),
    p = await service.saveMaster(token, {
      kind: "policies",
      id: null,
      rowVersion: null,
      data: {
        code,
        name: "Kebijakan 5 tahun",
        status: "active",
        method: "straight_line",
        version: 1,
        useful_life_months: 60,
        proration: "full_month",
      },
    });
  await create({
    ...base(),
    depreciation_policy_id: p.id as string,
    useful_life_months: 60,
  });
  const row = (await service.masters(token, { kind: "policies", query: code }))
    .items[0];
  await assert.rejects(() =>
    service.saveMaster(token, {
      kind: "policies",
      id: p.id,
      rowVersion: row.row_version,
      data: {
        code,
        name: row.name,
        status: "active",
        method: "straight_line",
        version: 2,
        useful_life_months: 120,
        proration: "full_month",
      },
    }),
  );
});
test("Posted depreciation protects acquisition basis while allowing description corrections", async () => {
  const r = await create(),
    id = r.ids[0],
    run = randomUUID();
  await db.pg.query(
    "INSERT INTO inventory.depreciation_runs(id,tenant_id,document_number,requested_by,period,policy_snapshot) VALUES($1,$2,$3,'00000000-0000-4000-8000-000000000021','2026-10-01','{}')",
    [run, A, "DEP-" + run],
  );
  await db.pg.query(
    "INSERT INTO inventory.depreciation_entries(tenant_id,run_id,asset_id,period,amount,book_value_after,posting_key) VALUES($1,$2,$3,'2026-10-01',1000,999000.01,$4)",
    [A, run, id, "DEP-" + run],
  );
  assert.equal((await service.detail(token, id)).asset.book_value, "999000.01");
  await assert.rejects(() =>
    edit(id, (a) => {
      a.acquisition_cost = "2000000.01";
    }),
  );
  await edit(id, (a) => {
    a.name = "Koreksi deskripsi";
  });
});
test("File link requires same tenant ready metadata and is idempotent", async () => {
  const r = await create(),
    conn = randomUUID(),
    folder = randomUUID(),
    file = randomUUID();
  // Metadata-only fixture: does not claim a live Google upload has happened.
  await db.pg.query(
    "INSERT INTO inventory.tenant_drive_connections(id,tenant_id,auth_mode,connection_version,root_folder_id,google_identity,status) VALUES($1,$2,'service_account',1,'TEST-ROOT-NOT-LIVE','test-only','retired')",
    [conn, A],
  );
  await db.pg.query(
    "INSERT INTO inventory.tenant_drive_folders(id,tenant_id,connection_id,purpose,google_folder_id,parent_folder_id) VALUES($1,$2,$3,'Aset','TEST-FOLDER-NOT-LIVE','TEST-ROOT-NOT-LIVE')",
    [folder, A, conn],
  );
  await db.pg.query(
    "INSERT INTO inventory.file_attachments(id,tenant_id,connection_id,folder_id,google_file_id,original_filename,mime_type,file_size,status,uploaded_by) VALUES($1,$2,$3,$4,'TEST-FILE-NOT-LIVE','dokumen.pdf','application/pdf',20,'ready','00000000-0000-4000-8000-000000000021')",
    [file, A, conn, folder],
  );
  await service.link(token, { assetId: r.ids[0], fileId: file });
  await service.link(token, { assetId: r.ids[0], fileId: file });
  assert.equal((await service.detail(token, r.ids[0])).attachments.length, 1);
  await db.pg.query(
    "UPDATE inventory.file_attachments SET status='failed' WHERE id=$1",
    [file],
  );
  await assert.rejects(() =>
    service.link(token, { assetId: r.ids[0], fileId: file }),
  );
  const t = await loginAs("test_admin_b", B);
  await assert.rejects(() =>
    service.link(t, {
      assetId: "00000000-0000-4000-8000-000000000052",
      fileId: file,
    }),
  );
});
test("Expired sessions cannot call constrained asset mutation directly", async () => {
  await db.pg.exec(
    "UPDATE inventory.app_sessions SET revoked_at=clock_timestamp()",
  );
  await assert.rejects(() =>
    service.create(token, {
      asset: base(),
      count: 1,
      idempotencyKey: randomUUID(),
    }),
  );
  await assert.rejects(
    () =>
      db.run(
        "runtime",
        {
          tenantId: A,
          userId: "00000000-0000-4000-8000-000000000011",
          membershipId: "00000000-0000-4000-8000-000000000021",
          sessionDigest: tokenDigest(token),
        },
        (q) =>
          q.query("SELECT inventory_security.save_asset(NULL,NULL,'{}',1,$1)", [
            randomUUID(),
          ]),
      ),
    (e: unknown) => (e as { code?: string })?.code === "42501",
  );
});
test("Oversized label code is rejected instead of silently truncated", async () => {
  await assert.rejects(
    () =>
      labelPdf(
        {
          rows: [
            {
              public_id: randomUUID(),
              inventory_code: "KODE/".repeat(50),
              name: "Aset",
            },
          ],
          tenantName: "Lembaga",
          width: 50,
          height: 30,
        },
        "https://inventaris.example",
      ),
    (e: unknown) => (e as { code?: string })?.code === "LABEL_CODE_TOO_LONG",
  );
});
