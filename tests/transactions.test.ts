import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestDatabase } from './helpers/database';
import { SessionRepository } from '../src/lib/session/repository';
import { AuthService, tokenDigest, type IdentityProvider } from '../src/lib/session/service';
import { TransactionService } from '../src/features/transactions/service';
import { TransactionController } from '../src/features/transactions/controller';
import { payload, type Kind, type Payload, type Options } from '../src/features/transactions/schemas';
import { cookieNames } from '../src/lib/security/http';
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002', ROOM = '00000000-0000-4000-8000-000000000041', MA = '00000000-0000-4000-8000-000000000021';
const db = new TestDatabase();
let auth: AuthService, s: TransactionService, admin: string, maker: string, makerId: string, identity = 'test_admin_a', o: Options, aid: string;
const provider: IdentityProvider = { async authenticate(username) { return { sso_user_id: identity, username, full_name: 'Uji', account_status: 'active', identity_version: 1, authenticated_at: new Date().toISOString(), request_id: 'tx-test' }; }, async getUserStatus(id) { return { sso_user_id: id, account_status: 'active', is_archived: false, can_authenticate: true, identity_version: 1, checked_at: new Date().toISOString(), request_id: 'tx-test' }; } };
async function login(id: string, tenant = A) { identity = id; const x = await auth.login({ username: 'test.' + id, password: 'test-only' }); return (await auth.switchTenant(x.token, tenant)).token; }
before(async () => { await db.init(); const uid = randomUUID(); await db.pg.query("INSERT INTO inventory.app_users(id,sso_user_id,username_snapshot,full_name_snapshot) VALUES($1,'transaction_maker','tx.maker','Petugas Uji')", [uid]); makerId = (await db.pg.query<{
    id: string;
}>("INSERT INTO inventory.tenant_memberships(tenant_id,app_user_id,role_id) SELECT $1,$2,id FROM inventory.roles WHERE tenant_id=$1 AND code='petugas' RETURNING id", [A, uid])).rows[0].id; });
after(() => db.close());
beforeEach(async () => { await db.pg.exec('DELETE FROM inventory.app_sessions;DELETE FROM inventory.sso_status_cache;DELETE FROM inventory.login_rate_limits;'); auth = new AuthService(new SessionRepository(db), provider, 'test-only-rate-secret-transactions'); s = new TransactionService(auth); admin = await login('test_admin_a'); maker = await login('transaction_maker'); o = await s.options(admin); await s.policy(admin, { mode: 'single_admin_v1', reason: 'Aktivasi eksplisit uji lokal' }); aid = (await db.pg.query<{
    id: string;
}>(`INSERT INTO inventory.assets(tenant_id,inventory_code,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id) SELECT $1,$2,'Aset transaksi',category_id,unit_id,condition_id,CURRENT_DATE,'purchase',1000,'available',room_id FROM inventory.assets WHERE id='00000000-0000-4000-8000-000000000051' RETURNING id`, [A, 'TX-' + randomUUID()])).rows[0].id; });
function data(kind: Kind, extra: Partial<Payload> = {}): Payload { return payload.parse({ kind, date: new Date().toISOString().slice(0, 10), reason: 'Pengujian transaksi aset', assets: [aid], roomId: ROOM, conditionId: o.conditions.find(c => c.code === 'BAIK')!.id, parentId: null, borrower: 'Peminjam Uji', startAt: new Date(Date.now() - 3600000).toISOString(), dueAt: new Date(Date.now() + 86400000).toISOString(), assigneeId: makerId, completedAt: new Date().toISOString(), ...extra }); }
async function save(kind: Kind, extra: Partial<Payload> = {}) { return (await s.save(maker, { key: randomUUID(), data: data(kind, extra) })).id; }
async function transition(id: string, action: string, token = admin) { const d = (await s.detail(token, id)).document; await s.transition(token, { id, version: d.row_version, action, reason: 'Pengujian ' + action }); }
async function approve(id: string) { if ((await s.detail(maker, id)).document.kind === 'disposal')
    await evidence(id); await transition(id, 'submit', maker); await transition(id, 'review'); await transition(id, 'approve'); }
async function post(kind: Kind, extra: Partial<Payload> = {}) { const id = await save(kind, extra); await approve(id); await s.post(maker, { id }); return id; }
async function evidence(id: string) {
    const previous = (await db.pg.query<{
        id: string;
    }>('SELECT id FROM inventory.tenant_drive_connections WHERE tenant_id=$1 LIMIT 1', [A])).rows[0];
    const conn = previous?.id ?? (await db.pg.query<{
        id: string;
    }>(`INSERT INTO inventory.tenant_drive_connections(tenant_id,auth_mode,connection_version,root_folder_id,google_identity) VALUES($1,'service_account',1,$2,'test-service') RETURNING id`, [A, 'root-' + randomUUID()])).rows[0].id;
    const oldFolder = (await db.pg.query<{
        id: string;
    }>("SELECT id FROM inventory.tenant_drive_folders WHERE tenant_id=$1 AND connection_id=$2 AND purpose='Penghapusan'", [A, conn])).rows[0];
    const folder = oldFolder?.id ?? (await db.pg.query<{
        id: string;
    }>(`INSERT INTO inventory.tenant_drive_folders(tenant_id,connection_id,purpose,google_folder_id,parent_folder_id) VALUES($1,$2,'Penghapusan',$3,'test-root') RETURNING id`, [A, conn, 'folder-' + randomUUID()])).rows[0].id;
    const file = (await db.pg.query<{
        id: string;
    }>(`INSERT INTO inventory.file_attachments(tenant_id,connection_id,folder_id,google_file_id,original_filename,mime_type,file_size,status,uploaded_by) VALUES($1,$2,$3,$4,'bukti-uji.pdf','application/pdf',100,'ready',$5) RETURNING id`, [A, conn, folder, 'file-' + randomUUID(), makerId])).rows[0].id;
    await s.link(maker, { id, fileId: file, purpose: 'evidence' });
    return file;
}
async function asset() { return (await db.pg.query<{
    lifecycle_status: string;
    room_id: string;
    condition_id: string;
    row_version: number;
}>('SELECT lifecycle_status,room_id,condition_id,row_version FROM inventory.assets WHERE id=$1', [aid])).rows[0]; }
const denied = (fn: () => Promise<unknown>, code?: string) => assert.rejects(fn, e => !code || (e as {
    code: string;
}).code === code);
test('Options and lists use safe member directory; viewer can read but not write', async () => { assert.ok(o.members.some(m => m.id === makerId)); const v = await login('test_viewer'); assert.equal((await s.options(v)).tenantId, A); await denied(() => s.save(v, { key: randomUUID(), data: data('movement') })); await denied(() => s.policy(maker, { mode: 'disabled', reason: 'Tidak boleh' })); });
test('Placement updates room and preserves audit; already placed asset denied', async () => { await denied(() => save('placement')); await db.pg.query('UPDATE inventory.assets SET room_id=NULL WHERE id=$1', [aid]); const id = await post('placement'); assert.equal((await asset()).room_id, ROOM); assert.equal((await s.detail(maker, id)).document.status, 'posted'); assert.ok((await db.pg.query('SELECT id FROM inventory.asset_location_history WHERE asset_id=$1', [aid])).rows.length); });
test('Movement assigns responsible person and posts exactly once', async () => { const id = await post('movement', { responsibleId: makerId }); const before = (await asset()).row_version; await s.post(maker, { id }); assert.equal((await asset()).row_version, before); assert.equal((await db.pg.query('SELECT id FROM inventory.asset_movements WHERE business_document_id=$1', [id])).rows.length, 1); });
test('Disabled policy, self approval, skipping review and premature posting are denied', async () => { const id = await save('loan'); await s.policy(admin, { mode: 'disabled', reason: 'Nonaktifkan uji' }); await denied(() => transition(id, 'submit', maker)); await s.policy(admin, { mode: 'single_admin_v1', reason: 'Aktifkan uji' }); await transition(id, 'submit', maker); await denied(() => transition(id, 'approve')); await denied(() => transition(id, 'review', maker)); await denied(() => s.post(maker, { id })); });
test('Loan and inspected partial return release exact parent reservation atomically', async () => { const loan = await post('loan'); assert.equal((await asset()).lifecycle_status, 'on_loan'); const bad = o.conditions.find(c => c.code === 'RUSAK_BERAT')!.id; const ret = await post('return', { parentId: loan, conditionId: bad }); assert.equal((await asset()).lifecycle_status, 'available'); assert.equal((await asset()).condition_id, bad); assert.equal((await db.pg.query('SELECT id FROM inventory.asset_reservations WHERE asset_id=$1 AND released_at IS NULL', [aid])).rows.length, 0); assert.ok((await s.detail(maker, loan)).related.some(r => r.id === ret)); await denied(() => save('loan')); });
test('Two approved loans cannot checkout the same asset', async () => { const one = await save('loan'), two = await save('loan'); await approve(one); await approve(two); await s.post(maker, { id: one }); await denied(() => s.post(maker, { id: two })); assert.equal((await s.detail(maker, two)).document.status, 'approved'); assert.equal((await db.pg.query('SELECT id FROM inventory.asset_reservations WHERE asset_id=$1 AND released_at IS NULL', [aid])).rows.length, 1); });
test('Return cannot be duplicated and must reference the matching source loan', async () => { const loan = await post('loan'); const one = await save('return', { parentId: loan }), two = await save('return', { parentId: loan }); await approve(one); await approve(two); await s.post(maker, { id: one }); await denied(() => s.post(maker, { id: two })); assert.equal((await db.pg.query('SELECT r.id FROM inventory.asset_return_items r JOIN inventory.asset_loan_items i ON i.id=r.loan_item_id WHERE i.asset_id=$1', [aid])).rows.length, 1); });
test('Maintenance blocks loan/disposal and completion records expense and condition', async () => { const id = await post('maintenance', { nextDueAt: new Date(Date.now() + 86400000).toISOString() }); assert.equal((await asset()).lifecycle_status, 'maintenance'); await denied(() => save('loan')); await denied(() => save('disposal')); await post('maintenance_finish', { parentId: id, cost: '12500.75' }); assert.equal((await asset()).lifecycle_status, 'available'); const costs = (await db.pg.query<{
    amount: string;
    treatment: string;
}>(`SELECT c.amount::text,c.treatment FROM inventory.maintenance_costs c JOIN inventory.maintenance_records r ON r.id=c.record_id JOIN inventory.maintenance_requests m ON m.id=r.request_id WHERE m.asset_id=$1`, [aid])).rows; assert.deepEqual(costs, [{ amount: '12500.75', treatment: 'expense' }]); await denied(() => save('maintenance_finish', { parentId: id })); });
test('Disposal preserves asset identity and acquisition basis; cannot loan again', async () => { const id = await post('disposal'); assert.equal((await asset()).lifecycle_status, 'disposed'); assert.equal((await db.pg.query('SELECT id FROM inventory.asset_disposals WHERE asset_id=$1', [aid])).rows.length, 1); await denied(() => save('loan')); await denied(() => save('movement')); assert.equal((await s.detail(maker, id)).document.status, 'posted'); });
test('Stale asset snapshot rejects entire multi-asset posting without partial effects', async () => { const extra = (await db.pg.query<{
    id: string;
}>(`INSERT INTO inventory.assets(tenant_id,inventory_code,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id) SELECT tenant_id,$1,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id FROM inventory.assets WHERE id=$2 RETURNING id`, ['TX-' + randomUUID(), aid])).rows[0].id; const id = await save('loan', { assets: [aid, extra] }); await approve(id); await db.pg.query('UPDATE inventory.assets SET name=name||$2 WHERE id=$1', [extra, ' changed']); await denied(() => s.post(maker, { id })); assert.equal((await asset()).lifecycle_status, 'available'); assert.equal((await db.pg.query('SELECT id FROM inventory.asset_reservations WHERE asset_id=ANY($1::uuid[]) AND released_at IS NULL', [[aid, extra]])).rows.length, 0); });
test('Idempotency mismatch, stale document and immutable posted revision denied', async () => { const key = randomUUID(), d = data('movement'); const one = await s.save(maker, { key, data: d }); assert.equal((await s.save(maker, { key, data: d })).id, one.id); await denied(() => s.save(maker, { key, data: { ...d, reason: 'Different content' } })); const v = (await s.detail(maker, one.id)).document.row_version; await transition(one.id, 'submit', maker); await denied(() => s.transition(maker, { id: one.id, version: v, action: 'cancel', reason: 'Stale request' })); await transition(one.id, 'review'); await transition(one.id, 'approve'); await s.post(maker, { id: one.id }); await denied(async () => s.save(maker, { id: one.id, version: (await s.detail(maker, one.id)).document.row_version, key: randomUUID(), data: d })); });
test('Revision replaces snapshot and requires a fresh independent approval', async () => { const id = await save('movement'); await transition(id, 'submit', maker); await transition(id, 'review'); await transition(id, 'revision'); const d = (await s.detail(maker, id)).document; await s.save(maker, { id, version: d.row_version, key: randomUUID(), data: data('movement', { reason: 'Revisi tujuan penanggung jawab', responsibleId: makerId }) }); assert.equal((await s.detail(maker, id)).document.revision, 2); await denied(() => s.post(maker, { id })); await approve(id); await s.post(maker, { id }); });
test('Opname assigned examiner, immutable expected snapshot, discrepancies and unregistered findings', async () => {
    const id = await save('opname', { assets: [], scopeRoomId: ROOM });
    const initial = await s.detail(maker, id);
    assert.ok(initial.lines.some(l => l.asset_id === aid));
    await denied(() => transition(id, 'submit', maker));
    const observe = async (assetId: string | null, data: unknown, token = maker) => { const v = (await s.detail(token, id)).document.row_version; return s.observe(token, { id, version: v, assetId, data }); };
    const obs = { finding: 'matched', roomId: ROOM, conditionId: o.conditions.find(c => c.code === 'BAIK')!.id, notes: 'Pemeriksaan fisik uji' };
    await denied(() => observe(aid, obs, admin));
    await db.pg.query('UPDATE inventory.assets SET name=$2 WHERE id=$1', [aid, 'Master berubah setelah snapshot']);
    for (const l of initial.lines)
        await observe(l.asset_id, l.asset_id === aid ? { ...obs, finding: 'not_found', roomId: null, conditionId: null } : obs);
    await observe(null, { finding: 'unregistered', roomId: null, conditionId: null, notes: 'Barang tanpa label ditemukan di lemari' });
    assert.equal((await s.detail(maker, id)).lines.find(l => l.asset_id === aid)!.snapshot.name, 'Aset transaksi');
    const before = await asset();
    await approve(id);
    await s.post(maker, { id });
    assert.deepEqual(await asset(), before);
    const findings = (await db.pg.query<{
        kind: string;
    }>('SELECT kind FROM inventory.stock_opname_findings WHERE session_id=(SELECT id FROM inventory.stock_opname_sessions WHERE business_document_id=$1)', [id])).rows.map(x => x.kind);
    assert.ok(findings.includes('missing'));
    assert.ok(findings.includes('unregistered'));assert.equal((await s.detail(maker,id)).unregistered.length,1);
    await denied(() => observe(aid, obs));
});
test('Opname automatically derives changed location/condition and preserves inspection history', async () => { const id = await save('opname', { assets: [], scopeRoomId: ROOM }); let d = await s.detail(maker, id); const bad = o.conditions.find(c => c.code === 'RUSAK_RINGAN')!.id; await s.observe(maker, { id, version: d.document.row_version, assetId: aid, data: { finding: 'matched', roomId: ROOM, conditionId: bad, notes: 'Kondisi fisik rusak ringan' } }); d = await s.detail(maker, id); assert.equal(d.lines.find(l => l.asset_id === aid)!.observation!.finding, 'condition_changed'); await denied(() => s.save(maker, { id, version: d.document.row_version, key: randomUUID(), data: data('opname', { assets: [] }) })); assert.ok(d.events.some(e => e.action === 'observe')); });
test('Cross-tenant asset, parent, room and document references are denied', async () => { await denied(() => save('loan', { assets: ['00000000-0000-4000-8000-000000000052'] })); await denied(() => save('movement', { roomId: '00000000-0000-4000-8000-000000000042' })); const id = await save('loan'), b = await login('test_admin_b', B); await denied(() => s.detail(b, id)); await denied(() => s.post(b, { id })); await denied(() => s.save(b, { key: randomUUID(), data: data('return', { parentId: id }) })); });
test('Native workflow configuration blocks limited policy at submit and post', async () => { const id = await save('movement'); const wf = (await db.pg.query<{
    id: string;
}>(`INSERT INTO inventory.approval_workflows(tenant_id,code,name,transaction_type,status) VALUES($1,$2,'Workflow uji','asset_movement','active') RETURNING id`, [A, 'WF-' + randomUUID()])).rows[0].id; await denied(() => transition(id, 'submit', maker)); await db.pg.query("UPDATE inventory.approval_workflows SET status='archived' WHERE id=$1", [wf]); await approve(id); await db.pg.query("UPDATE inventory.approval_workflows SET status='active' WHERE id=$1", [wf]); await denied(() => s.post(maker, { id })); await db.pg.query("UPDATE inventory.approval_workflows SET status='archived' WHERE id=$1", [wf]); });
test('Cancelled and rejected documents cannot post', async () => { let id = await save('disposal'); await transition(id, 'cancel', maker); await denied(() => s.post(maker, { id })); id = await save('disposal'); await evidence(id); await transition(id, 'submit', maker); await transition(id, 'review'); await transition(id, 'reject'); await denied(() => s.post(maker, { id })); });
test('DB direct runtime DML is denied on all operational tables and event history is append-only', async () => { const x = await auth.session(admin); await db.run('runtime', { tenantId: A, userId: x.user.id, membershipId: MA, sessionDigest: tokenDigest(admin) }, async (q) => { for (const table of ['asset_transactions', 'asset_transaction_lines', 'asset_transaction_events', 'asset_movements', 'asset_loans', 'asset_returns', 'asset_reservations', 'maintenance_records', 'stock_opname_items', 'asset_disposals']) {
    const r = (await q.query<{
        allowed: boolean;
    }>("SELECT has_table_privilege(current_user,$1,'INSERT') allowed", ['inventory.' + table])).rows[0];
    assert.equal(r.allowed, false, table);
} }); const id = await save('loan'); await denied(() => db.pg.query("UPDATE inventory.asset_transaction_events SET reason='rewrite' WHERE transaction_id=$1", [id])); });
test('Controller checks CSRF, method, active tenant, no-store and revoked session', async () => { const c = new TransactionController(s, 'https://inventaris.test'), name = cookieNames('https://inventaris.test').session; const req = (method: string, tenant = A, extra: Record<string, string> = {}) => new Request('https://inventaris.test/api/transactions/options', { method, headers: { cookie: name + '=' + admin, 'X-Tenant-Context': tenant, ...extra } }); assert.equal((await c.handle('options', req('GET'))).status, 200); assert.equal((await c.handle('options', req('POST'))).status, 405); assert.equal((await c.handle('save', req('POST'))).status, 403); assert.equal((await c.handle('options', req('GET', B))).status, 409); const r = await c.handle('options', req('GET')); assert.match(r.headers.get('cache-control') ?? '', /no-store/); await auth.logout(admin); assert.equal((await c.handle('options', req('GET'))).status, 401); });
test('QR resolves only current tenant and validated app origin', async () => { const r = (await db.pg.query<{
    inventory_code: string;
    public_id: string;
}>('SELECT inventory_code,public_id FROM inventory.assets WHERE id=$1', [aid])).rows[0]; assert.equal((await s.scan(maker, r.inventory_code, 'https://inventaris.test')).id, aid); assert.equal((await s.scan(maker, 'https://inventaris.test/aset/qr/' + r.public_id, 'https://inventaris.test')).id, aid); await denied(() => s.scan(maker, 'https://evil.test/aset/qr/' + r.public_id, 'https://inventaris.test')); await denied(() => s.scan(maker, 'MISSING-CODE', 'https://inventaris.test')); });
test('Loan overdue alert clears on return; maintenance due alert is visible', async () => { const loan = await post('loan'); await db.pg.query("UPDATE inventory.asset_loans SET planned_checkout_at=clock_timestamp()-interval '2 days',due_at=clock_timestamp()-interval '1 day' WHERE business_document_id=$1", [loan]); assert.ok((await s.alerts(maker)).overdue.some(x => x.id === loan)); await post('return', { parentId: loan }); assert.ok(!(await s.alerts(maker)).overdue.some(x => x.id === loan)); await post('maintenance', { startAt: new Date(Date.now() - 86400000).toISOString(), nextDueAt: new Date(Date.now() - 3600000).toISOString() }); assert.ok((await s.alerts(maker)).maintenance.length > 0); });
test('Schemas reject invalid dates, duplicate assets, excess quantities and invented fields', () => { assert.equal(payload.safeParse({ ...data('loan'), dueAt: '2020-01-01T00:00:00Z' }).success, false); assert.equal(payload.safeParse({ ...data('movement'), assets: [aid, aid] }).success, false); assert.equal(payload.safeParse({ ...data('movement'), assets: Array.from({ length: 51 }, () => randomUUID()) }).success, false); assert.equal(payload.safeParse({ ...data('movement'), date: '2026-02-30' }).success, false); assert.equal(payload.safeParse({ ...data('movement'), tenantId: B }).success, false); });
test('Disposal requires ready evidence, and wrong tenant or missing file cannot attach', async () => { const id = await save('disposal'); await denied(() => transition(id, 'submit', maker)); await denied(() => s.link(maker, { id, fileId: randomUUID(), purpose: 'evidence' })); await evidence(id); assert.equal((await s.detail(maker, id)).files.length, 1);assert.ok((await s.fileChoices(maker,{query:'bukti-uji'})).rows.length>0); await transition(id, 'submit', maker); });
test('Maintenance capitalization proposal is separate and does not increase asset cost', async () => { const m = await post('maintenance'); await post('maintenance_finish', { parentId: m, cost: '500.25', costTreatment: 'capitalization_review' }); const costs = (await db.pg.query<{
    treatment: string;
    capitalization_status: string;
}>(`SELECT c.treatment,c.capitalization_status FROM inventory.maintenance_costs c JOIN inventory.maintenance_records r ON r.id=c.record_id JOIN inventory.maintenance_requests m ON m.id=r.request_id WHERE m.asset_id=$1`, [aid])).rows; assert.deepEqual(costs, [{ treatment: 'capitalization', capitalization_status: 'pending_policy' }]); assert.equal((await db.pg.query<{
    v: string;
}>('SELECT acquisition_cost::text v FROM inventory.assets WHERE id=$1', [aid])).rows[0].v, '1000.00'); });
test('Partial return of a two-asset loan keeps remaining reservation and can be completed later', async () => { const extra = (await db.pg.query<{
    id: string;
}>(`INSERT INTO inventory.assets(tenant_id,inventory_code,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id) SELECT tenant_id,$1,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id FROM inventory.assets WHERE id=$2 RETURNING id`, ['TX-' + randomUUID(), aid])).rows[0].id; const loan = await post('loan', { assets: [aid, extra] }); await post('return', { parentId: loan, assets: [aid] }); let r = (await db.pg.query('SELECT id FROM inventory.asset_reservations WHERE asset_id=ANY($1::uuid[]) AND released_at IS NULL', [[aid, extra]])).rows; assert.equal(r.length, 1); await post('return', { parentId: loan, assets: [extra] }); r = (await db.pg.query('SELECT id FROM inventory.asset_reservations WHERE asset_id=ANY($1::uuid[]) AND released_at IS NULL', [[aid, extra]])).rows; assert.equal(r.length, 0); });
test('Approved document rechecks target status and evidence before posting', async () => { const id = await save('disposal'); await approve(id); const f = (await s.detail(maker, id)).files[0].id; await db.pg.query("UPDATE inventory.file_attachments SET status='missing' WHERE id=$1", [f]); await denied(() => s.post(maker, { id })); assert.equal((await asset()).lifecycle_status, 'available'); });
test('Stale approved document can be returned by reviewer for a new snapshot and approval', async () => { const id = await save('movement'); await approve(id); await db.pg.query('UPDATE inventory.assets SET name=$2 WHERE id=$1', [aid, 'Aset berubah']); await denied(() => s.post(maker, { id })); await transition(id, 'revision'); const d = (await s.detail(maker, id)).document; await s.save(maker, { id, version: d.row_version, key: randomUUID(), data: data('movement') }); await approve(id); await s.post(maker, { id }); assert.equal((await s.detail(maker, id)).document.status, 'posted'); });
