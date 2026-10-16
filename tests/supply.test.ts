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
import { SupplyService, mapSupplyError } from "../src/features/supply/service";
import { SupplyController } from "../src/features/supply/controller";
import {
  document,
  decimal,
  type Options,
  type Kind,
} from "../src/features/supply/schemas";
import { cookieNames } from "../src/lib/security/http";
import type { AssetInput } from "../src/features/assets/schemas";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002",
  ROOM = "00000000-0000-4000-8000-000000000041",
  MA = "00000000-0000-4000-8000-000000000021";
const db = new TestDatabase();
let auth: AuthService,
  s: SupplyService,
  adminToken: string,
  makerToken: string,
  identityId = "test_admin_a",
  o: Options,
  itemId: string,
  unitId: string;
const provider: IdentityProvider = {
  async authenticate(username) {
    return {
      sso_user_id: identityId,
      username,
      full_name: "Uji",
      account_status: "active",
      identity_version: 1,
      authenticated_at: new Date().toISOString(),
      request_id: "supply-test",
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
      request_id: "supply-test",
    };
  },
};
async function login(id: string, tenant = A) {
  identityId = id;
  const x = await auth.login({ username: "test." + id, password: "test-only" });
  return (await auth.switchTenant(x.token, tenant)).token;
}
before(async () => {
  await db.init();
  const u = randomUUID();
  await db.pg.query(
    "INSERT INTO inventory.app_users(id,sso_user_id,username_snapshot,full_name_snapshot) VALUES($1,'supply_maker','supply.maker','Petugas Pengadaan Uji')",
    [u],
  );
  await db.pg.query(
    "INSERT INTO inventory.tenant_memberships(tenant_id,app_user_id,role_id) SELECT $1,$2,id FROM inventory.roles WHERE tenant_id=$1 AND code='petugas'",
    [A, u],
  );
  // Test fixture explicitly authorizes adjustment for the maker; approval remains Admin-only.
  await db.pg.query(
    "INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code) SELECT $1,id,'inventory.adjust' FROM inventory.roles WHERE tenant_id=$1 AND code='petugas' ON CONFLICT DO NOTHING",
    [A],
  );
});
after(async () => db.close());
beforeEach(async () => {
  await db.pg.exec(
    "DELETE FROM inventory.app_sessions;DELETE FROM inventory.sso_status_cache;DELETE FROM inventory.login_rate_limits;",
  );
  auth = new AuthService(
    new SessionRepository(db),
    provider,
    "supply-rate-secret-test-public-only",
  );
  s = new SupplyService(auth);
  adminToken = await login("test_admin_a");
  makerToken = await login("supply_maker");
  await s.policy(adminToken, {
    mode: "single_admin_v1",
    reason: "Aktivasi eksplisit untuk pengujian lokal",
  });
  o = await s.options(adminToken);
  unitId = o.units.find((u) => u.code === "RIM")!.id;
  const result = await s.master(adminToken, {
    kind: "item",
    id: null,
    rowVersion: null,
    data: {
      code: "IT_" + randomUUID().slice(0, 8).toUpperCase(),
      name: "Barang Uji",
      status: "active",
      unitId,
      categoryId: o.categories.find((c) => c.code === "HABIS_PAKAI")!.id,
      minimumStock: "5",
    },
  });
  itemId = result.id as string;
});
async function save(
  kind: Kind,
  lines: unknown[],
  extra: Record<string, unknown> = {},
  token = makerToken,
) {
  return (
    await s.save(token, {
      kind,
      id: null,
      rowVersion: null,
      idempotencyKey: randomUUID(),
      date: "2026-01-01",
      reason: "Dokumen pengujian tahap tujuh",
      ...(kind === "request"
        ? { roomId: ROOM, fundingId: null }
        : kind === "order"
          ? { supplierId: "", fundingId: null }
          : kind === "receipt"
            ? {}
            : { correctsDocumentId: null }),
      ...extra,
      lines,
    })
  ).id;
}
async function transition(id: string, action: string, token = adminToken) {
  const d = await s.detail(token, id);
  return s.transition(token, {
    id,
    rowVersion: d.doc.row_version,
    action,
    reason: "Keputusan pengujian terotorisasi",
  });
}
async function approve(id: string, maker = makerToken) {
  await transition(id, "submit", maker);
  await transition(id, "review");
  await transition(id, "approve");
}
async function stock(
  kind: "receipt_stock" | "issue" | "adjustment",
  qty: string,
  cost = "0",
  post = true,
) {
  const id = await save(kind, [
    { itemId, roomId: ROOM, quantity: qty, unitCost: cost },
  ]);
  await approve(id);
  if (post) await s.post(makerToken, { id, idempotencyKey: randomUUID() });
  return id;
}
async function balance() {
  return (
    (
      await db.pg.query<{ quantity: string; stock_value: string }>(
        "SELECT quantity::text,stock_value::text FROM inventory.inventory_stock_balances WHERE tenant_id=$1 AND item_id=$2 AND room_id=$3",
        [A, itemId, ROOM],
      )
    ).rows[0] ?? { quantity: "0", stock_value: "0" }
  );
}
async function order(
  destination = "inventory",
  template?: AssetInput,
  quantity = "10",
  cost = "2.50",
  u = unitId,
) {
  const request = await save("request", [
    { description: "Kebutuhan Uji", unitId: u, quantity, unitCost: cost },
  ]);
  await approve(request);
  const rd = await s.detail(makerToken, request);
  const supplier = (
    await s.master(adminToken, {
      kind: "supplier",
      id: null,
      rowVersion: null,
      data: {
        code: "SUP_" + randomUUID().slice(0, 8).toUpperCase(),
        name: "Penyedia Uji",
        status: "active",
      },
    })
  ).id;
  const id = await save(
    "order",
    [
      {
        requestItemId: rd.lines[0].id,
        description: "Barang pengadaan",
        unitId: u,
        quantity,
        unitCost: cost,
        destination,
        itemId: destination === "inventory" ? itemId : null,
        asset: template ?? null,
      },
    ],
    { requestId: rd.doc.source_id, supplierId: supplier },
  );
  await approve(id);
  return s.detail(makerToken, id);
}
async function receive(
  d: Awaited<ReturnType<typeof order>>,
  quantity: string,
  accepted = quantity,
  post = true,
) {
  const id = await save(
    "receipt",
    [
      {
        orderItemId: d.lines[0].id,
        quantity,
        accepted,
        roomId: ROOM,
        inspection: "Diperiksa oleh petugas penerimaan",
      },
    ],
    { orderId: d.doc.source_id },
  );
  await approve(id);
  if (post) await s.post(makerToken, { id, idempotencyKey: randomUUID() });
  return id;
}
test("Strict decimal DTO rejects exponent and tenant/value overrides", () => {
  for (const value of ["1e6", "-2", "1,000", "1.1234567"])
    assert.equal(decimal.safeParse(value).success, false);
  assert.equal(
    document.safeParse({ kind: "issue", tenant_id: B }).success,
    false,
  );
});
test("Policy defaults disabled for a newly created tenant", async () => {
  const row = (
    await db.pg.query<{ supply_review_mode: string }>(
      "SELECT supply_review_mode FROM inventory.tenant_settings WHERE tenant_id=$1",
      [B],
    )
  ).rows[0];
  assert.equal(row.supply_review_mode, "disabled");
});
test("Explicit policy required; no approval or posting from draft", async () => {
  await s.policy(adminToken, {
    mode: "disabled",
    reason: "Uji kebijakan nonaktif",
  });
  const id = await save("receipt_stock", [
    { itemId, roomId: ROOM, quantity: "1", unitCost: "2" },
  ]);
  await assert.rejects(() => transition(id, "submit", makerToken));
  await assert.rejects(() =>
    s.post(makerToken, { id, idempotencyKey: randomUUID() }),
  );
});
test("Self approval and skipped review are rejected", async () => {
  const id = await save(
    "request",
    [{ description: "Uji", unitId, quantity: "1", unitCost: "2" }],
    {},
    adminToken,
  );
  await transition(id, "submit", adminToken);
  await assert.rejects(() => transition(id, "review", adminToken));
  const other = await save("request", [
    { description: "Uji", unitId, quantity: "1", unitCost: "2" },
  ]);
  await transition(other, "submit", makerToken);
  await assert.rejects(() => transition(other, "approve"));
});
test("Moving average values issue and clears residual cents on exhaustion", async () => {
  await stock("receipt_stock", "3", "3.333333");
  assert.deepEqual(await balance(), {
    quantity: "3.000000",
    stock_value: "10.00",
  });
  await stock("receipt_stock", "2", "5");
  await stock("issue", "-1");
  assert.deepEqual(await balance(), {
    quantity: "4.000000",
    stock_value: "16.00",
  });
  await stock("issue", "-4");
  assert.deepEqual(await balance(), {
    quantity: "0.000000",
    stock_value: "0.00",
  });
});
test("Negative stock posting rolls back the whole document", async () => {
  await stock("receipt_stock", "2", "10");
  const id = await stock("issue", "-3", "999999", false);
  await assert.rejects(
    () => s.post(makerToken, { id, idempotencyKey: randomUUID() }),
    (e: unknown) => mapSupplyError(e).code === "SUPPLY_RULE_DENIED",
  );
  assert.deepEqual(await balance(), {
    quantity: "2.000000",
    stock_value: "20.00",
  });
  assert.equal((await s.detail(makerToken, id)).doc.status, "approved");
});
test("Posting retry with different request key never duplicates ledger", async () => {
  const id = await stock("receipt_stock", "5", "2");
  assert.equal(
    (await s.post(makerToken, { id, idempotencyKey: randomUUID() })).reused,
    true,
  );
  assert.equal(
    (
      await db.pg.query<{ n: number }>(
        "SELECT count(*)::int n FROM inventory.inventory_stock_ledger WHERE source_document_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
});
test("Save retry idempotency and changed payload conflict", async () => {
  const b = {
    kind: "request",
    id: null,
    rowVersion: null,
    idempotencyKey: randomUUID(),
    date: "2026-01-01",
    reason: "Kebutuhan uji",
    roomId: ROOM,
    fundingId: null,
    lines: [{ description: "Barang", unitId, quantity: "1", unitCost: "2" }],
  };
  const a = await s.save(makerToken, b),
    c = await s.save(makerToken, b);
  assert.equal(a.id, c.id);
  await assert.rejects(() => s.save(makerToken, { ...b, reason: "Berbeda" }));
});
test("Positive and negative adjustments use auditable documents", async () => {
  await stock("adjustment", "10", "2.5");
  await stock("adjustment", "-2");
  assert.deepEqual(await balance(), {
    quantity: "8.000000",
    stock_value: "20.00",
  });
});
test("Multi-line shortage produces no partial ledger write", async () => {
  await stock("receipt_stock", "2", "1");
  const id = await save("issue", [
    { itemId, roomId: ROOM, quantity: "-1", unitCost: "0" },
    {
      itemId: "00000000-0000-4000-8000-000000000061",
      roomId: ROOM,
      quantity: "-999999",
      unitCost: "0",
    },
  ]);
  await approve(id);
  await assert.rejects(() =>
    s.post(makerToken, { id, idempotencyKey: randomUUID() }),
  );
  assert.equal((await balance()).quantity, "2.000000");
  assert.equal(
    (
      await db.pg.query<{ n: number }>(
        "SELECT count(*)::int n FROM inventory.inventory_stock_ledger WHERE source_document_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
});
test("Partial inspected receipt rejects damaged units from stock", async () => {
  const d = await order();
  await receive(d, "6", "4");
  assert.deepEqual(await balance(), {
    quantity: "4.000000",
    stock_value: "10.00",
  });
  const current = await s.detail(makerToken, d.doc.id);
  assert.equal(current.lines[0].received_quantity, "4.000000");
  assert.equal(current.doc.status, "approved");
  await receive(current, "6");
  assert.equal((await balance()).quantity, "10.000000");
  assert.equal((await s.detail(makerToken, d.doc.id)).doc.status, "posted");
});
test("Pending competing receipts are rechecked at posting", async () => {
  const d = await order("inventory", undefined, "5");
  const a = await receive(d, "4", "4", false),
    b = await receive(d, "4", "4", false);
  await s.post(makerToken, { id: a, idempotencyKey: randomUUID() });
  await assert.rejects(() =>
    s.post(makerToken, { id: b, idempotencyKey: randomUUID() }),
  );
  assert.equal((await balance()).quantity, "4.000000");
});
test("Over-order beyond approved request is rejected", async () => {
  const d = await order("inventory", undefined, "5");
  const original = d.doc.input_snapshot as Record<string, unknown>;
  await assert.rejects(() =>
    s.save(makerToken, {
      ...original,
      id: null,
      rowVersion: null,
      idempotencyKey: randomUUID(),
    }),
  );
});
test("Procurement inventory unit mismatch is rejected", async () => {
  const request = await save("request", [
    {
      description: "Uji",
      unitId: o.units.find((u) => u.code === "UNIT")!.id,
      quantity: "1",
      unitCost: "1",
    },
  ]);
  await approve(request);
  const rd = await s.detail(makerToken, request),
    supplier = (
      await s.master(adminToken, {
        kind: "supplier",
        id: null,
        rowVersion: null,
        data: {
          code: "SP_" + randomUUID().slice(0, 6).toUpperCase(),
          name: "Supplier",
          status: "active",
        },
      })
    ).id;
  await assert.rejects(() =>
    save(
      "order",
      [
        {
          requestItemId: rd.lines[0].id,
          description: "Barang",
          unitId: o.units.find((u) => u.code === "UNIT")!.id,
          quantity: "1",
          unitCost: "1",
          destination: "inventory",
          itemId,
          asset: null,
        },
      ],
      { requestId: rd.doc.source_id, supplierId: supplier },
    ),
  );
});
test("Approved asset receipt creates per-unit draft assets once", async () => {
  const unit = o.units.find((u) => u.code === "UNIT")!.id;
  const cat = (
    await db.pg.query<{ id: string }>(
      "SELECT id FROM inventory.asset_categories WHERE tenant_id=$1 AND code='ELEKTRONIK'",
      [A],
    )
  ).rows[0].id;
  const condition = (
    await db.pg.query<{ id: string }>(
      "SELECT id FROM inventory.asset_conditions WHERE tenant_id=$1 AND code='BAIK'",
      [A],
    )
  ).rows[0].id;
  const template: AssetInput = {
    name: "Laptop Pengadaan",
    category_id: cat,
    subcategory_id: null,
    unit_id: unit,
    funding_source_id: null,
    room_id: null,
    responsible_membership_id: null,
    condition_id: condition,
    lifecycle_status: "draft",
    brand: "Merek",
    model: "Model",
    serial_number: "",
    specifications: "Spesifikasi uji",
    acquisition_date: "2026-01-01",
    in_service_date: null,
    acquisition_method: "Pembelian",
    acquisition_cost: "100",
    residual_value: "0",
    useful_life_months: null,
    depreciation_policy_id: null,
    notes: "",
    detail: { type: "general" },
    reason: "Pengadaan aset",
  };
  const d = await order("asset", template, "2", "100", unit),
    receipt = await receive(d, "2");
  await s.post(makerToken, { id: receipt, idempotencyKey: randomUUID() });
  const rows = (
    await db.pg.query<{
      id: string;
      acquisition_cost: string;
      room_id: string;
    }>(
      "SELECT a.id,a.acquisition_cost::text,a.room_id FROM inventory.assets a JOIN inventory.receipt_asset_links l ON l.tenant_id=a.tenant_id AND l.asset_id=a.id JOIN inventory.goods_receipt_items i ON i.tenant_id=l.tenant_id AND i.id=l.receipt_item_id JOIN inventory.goods_receipts r ON r.tenant_id=i.tenant_id AND r.id=i.receipt_id WHERE r.business_document_id=$1",
      [receipt],
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((x) => x.id)).size, 2);
  assert.equal(rows[0].acquisition_cost, "100.00");
  assert.equal(rows[0].room_id, ROOM);
  assert.equal((await balance()).quantity, "0");
});
test("Revision requires resubmission and optimistic version check", async () => {
  const id = await save("request", [
    { description: "Uji", unitId, quantity: "1", unitCost: "1" },
  ]);
  await transition(id, "submit", makerToken);
  await transition(id, "review");
  await transition(id, "revision");
  const d = await s.detail(makerToken, id);
  const snap = d.doc.input_snapshot as Record<string, unknown>;
  await s.save(makerToken, {
    ...snap,
    id,
    rowVersion: d.doc.row_version,
    idempotencyKey: randomUUID(),
    reason: "Revisi kebutuhan",
  });
  assert.equal((await s.detail(makerToken, id)).doc.status, "draft");
  await assert.rejects(() =>
    s.save(makerToken, {
      ...snap,
      id,
      rowVersion: d.doc.row_version,
      idempotencyKey: randomUUID(),
    }),
  );
});
test("Viewer sees balance/card but cannot mutate or read procurement documents", async () => {
  const request = await save("request", [
      { description: "Uji", unitId, quantity: "1", unitCost: "1" },
    ]),
    t = await login("test_viewer");
  assert.ok((await s.balances(t, {})).total > 0);
  await assert.rejects(() => s.detail(t, request));
  await assert.rejects(() =>
    s.policy(t, { mode: "single_admin_v1", reason: "Tidak boleh" }),
  );
  await assert.rejects(() =>
    save(
      "issue",
      [{ itemId, roomId: ROOM, quantity: "-1", unitCost: "0" }],
      {},
      t,
    ),
  );
});
test("Tenant B cannot read A documents, balances or ledger card", async () => {
  const id = await save("request", [
      { description: "Uji", unitId, quantity: "1", unitCost: "1" },
    ]),
    t = await login("test_admin_b", B);
  await assert.rejects(() => s.detail(t, id));
  await assert.rejects(() => s.card(t, { itemId }));
  assert.equal((await s.balances(t, {})).total, 0);
});
test("Stock card and usage reflect posted transactions only", async () => {
  await stock("receipt_stock", "10", "3");
  await stock("issue", "-4");
  const card = await s.card(makerToken, { itemId });
  assert.equal(card.total, 2);
  assert.equal(card.entries[0].running_quantity, "6.000000");
  const usage = await s.usage(makerToken, {
    from: "2026-01-01",
    to: "2026-12-31",
  });
  const row = usage.items.find((r) => r.id === itemId)!;
  assert.equal(row.quantity, "4.000000");
  assert.equal(row.value, "12.00");
  const low = await s.balances(makerToken, { low: true });
  assert.ok(!low.items.some((r) => r.id === itemId));
});
test("Raw runtime cannot alter balances, headers, quantities or decision evidence", async () => {
  for (const table of [
    "inventory_stock_balances",
    "procurements",
    "goods_receipt_items",
    "inventory_items",
    "supply_review_events",
  ]) {
    await assert.rejects(
      () =>
        db.run("runtime", { tenantId: A }, (q) =>
          q.query(`DELETE FROM inventory.${table}`),
        ),
      (e: unknown) => (e as { code?: string }).code === "42501",
    );
  }
});
test("Revoked session cannot directly call supply writer", async () => {
  await db.pg.exec(
    "UPDATE inventory.app_sessions SET revoked_at=clock_timestamp()",
  );
  await assert.rejects(() =>
    db.run(
      "runtime",
      {
        tenantId: A,
        userId: "00000000-0000-4000-8000-000000000011",
        membershipId: MA,
        sessionDigest: tokenDigest(adminToken),
      },
      (q) =>
        q.query("SELECT inventory_security.supply_save(NULL,NULL,$1,'{}')", [
          randomUUID(),
        ]),
    ),
  );
});
test("Controller rejects stale tenant header and absent CSRF", async () => {
  const c = new SupplyController(s, "https://app.example"),
    names = cookieNames("https://app.example"),
    headers = { Cookie: `${names.session}=${makerToken}` };
  assert.equal(
    (
      await c.handle(
        "balances",
        new Request("https://app.example/api/supply/balances", {
          headers: { ...headers, "X-Tenant-Context": B },
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await c.handle(
        "save",
        new Request("https://app.example/api/supply/save", {
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
test("General workflow configuration blocks interim submission and review", async () => {
  const id = await save("request", [
    { description: "Uji workflow", unitId, quantity: "1", unitCost: "1" },
  ]);
  const workflow = randomUUID();
  await db.pg.query(
    "INSERT INTO inventory.approval_workflows(id,tenant_id,code,name,transaction_type) VALUES($1,$2,$3,'Workflow umum','procurement_request')",
    [workflow, A, "WF_" + workflow],
  );
  await assert.rejects(
    () => transition(id, "submit", makerToken),
    (e: unknown) => mapSupplyError(e).code === "SUPPLY_RULE_DENIED",
  );
  await db.pg.query(
    "UPDATE inventory.approval_workflows SET status='archived' WHERE id=$1",
    [workflow],
  );
  await transition(id, "submit", makerToken);
  await db.pg.query(
    "UPDATE inventory.approval_workflows SET status='active' WHERE id=$1",
    [workflow],
  );
  await assert.rejects(() => transition(id, "review"));
  await db.pg.query(
    "UPDATE inventory.approval_workflows SET status='archived' WHERE id=$1",
    [workflow],
  );
});
test("Issue unit price is ignored in favor of the locked moving average", async () => {
  await stock("receipt_stock", "10", "7");
  await stock("issue", "-2", "99999999");
  assert.deepEqual(await balance(), {
    quantity: "8.000000",
    stock_value: "56.00",
  });
});
test("All-rejected delivery closes receipt without adding stock", async () => {
  const d = await order("inventory", undefined, "2", "1"),
    id = await receive(d, "2", "0");
  assert.equal((await s.detail(makerToken, id)).doc.status, "posted");
  assert.equal((await balance()).quantity, "0");
  assert.equal((await s.detail(makerToken, d.doc.id)).doc.status, "approved");
});
test("Receipt cent allocation totals exactly to the purchased line value", async () => {
  const d = await order("inventory", undefined, "3", "0.333333");
  await receive(d, "1");
  await receive(await s.detail(makerToken, d.doc.id), "1");
  await receive(await s.detail(makerToken, d.doc.id), "1");
  assert.deepEqual(await balance(), {
    quantity: "3.000000",
    stock_value: "1.00",
  });
});
test("Used base unit and positive-stock archive are protected", async () => {
  await stock("receipt_stock", "1", "1");
  const row = (await s.options(adminToken)).items.find((i) => i.id === itemId)!;
  const b = {
    kind: "item",
    id: itemId,
    rowVersion: String(row.row_version),
    data: {
      code: row.code,
      name: row.name,
      status: "active",
      unitId: o.units.find((u) => u.code === "UNIT")!.id,
      categoryId: row.category_id,
      minimumStock: "5",
    },
  };
  await assert.rejects(() => s.master(adminToken, b));
  await assert.rejects(() =>
    s.master(adminToken, {
      ...b,
      data: { ...b.data, unitId, status: "archived" },
    }),
  );
});
test("Cancelled order releases request allocation without touching ledger", async () => {
  const request = await save("request", [
    { description: "Uji pembatalan", unitId, quantity: "2", unitCost: "1" },
  ]);
  await approve(request);
  const rd = await s.detail(makerToken, request),
    supplier = (
      await s.master(adminToken, {
        kind: "supplier",
        id: null,
        rowVersion: null,
        data: {
          code: "CN_" + randomUUID().slice(0, 6).toUpperCase(),
          name: "Penyedia",
          status: "active",
        },
      })
    ).id;
  const extra = { requestId: rd.doc.source_id, supplierId: supplier };
  const lines = [
    {
      requestItemId: rd.lines[0].id,
      description: "Barang",
      unitId,
      quantity: "2",
      unitCost: "1",
      destination: "inventory",
      itemId,
      asset: null,
    },
  ];
  const id = await save("order", lines, extra);
  await transition(id, "cancel", makerToken);
  await save("order", lines, extra);
  assert.equal((await balance()).quantity, "0");
});
test("Posted stock document and audit events cannot be rewritten", async () => {
  const id = await stock("receipt_stock", "1", "1"),
    d = await s.detail(makerToken, id);
  await assert.rejects(() =>
    s.save(makerToken, {
      ...(d.doc.input_snapshot as Record<string, unknown>),
      id,
      rowVersion: d.doc.row_version,
      idempotencyKey: randomUUID(),
    }),
  );
  await assert.rejects(
    () =>
      db.pg.query(
        "UPDATE inventory.supply_review_events SET reason='rewritten' WHERE document_id=$1",
        [id],
      ),
    (e: unknown) => (e as { code?: string }).code === "55000",
  );
});
test("Cross-tenant stock room is rejected before any ledger insertion", async () => {
  await assert.rejects(() =>
    save("receipt_stock", [
      {
        itemId,
        roomId: "00000000-0000-4000-8000-000000000042",
        quantity: "1",
        unitCost: "1",
      },
    ]),
  );
  assert.equal((await balance()).quantity, "0");
});
