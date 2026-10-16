import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {TestDatabase} from './helpers/database';
import {assertCsrf,cookieNames,readJson} from '../src/lib/security/http';
const db=new TestDatabase();
const A='00000000-0000-4000-8000-000000000001';
before(()=>db.init());after(()=>db.close());
test('Stage12: rollback clears tenant context before next transaction',async()=>{
 await assert.rejects(()=>db.run('runtime',{tenantId:A},async q=>{assert.equal((await q.query('SELECT id FROM inventory.assets')).rows.length,1);throw new Error('Intentional rollback')}));
 await db.run('runtime',{},async q=>assert.equal((await q.query('SELECT id FROM inventory.assets')).rows.length,0));
});
test('Stage12: every readable tenant table denies rows without tenant context',async()=>{
 const tables=(await db.pg.query<{table_name:string}>(`SELECT t.table_name FROM information_schema.columns t WHERE t.table_schema='inventory' AND t.column_name='tenant_id' AND has_table_privilege('inventory_runtime','inventory.'||quote_ident(t.table_name),'SELECT')`)).rows;
 assert.ok(tables.length>50);
 await db.run('runtime',{},async q=>{for(const t of tables){assert.match(t.table_name,/^[a-z_]+$/);assert.equal((await q.query<{n:string}>('SELECT count(*)::text n FROM inventory."'+t.table_name+'"')).rows[0].n,'0',t.table_name)}});
});
test('Stage12: auth/runtime roles cannot create objects in application schemas',async()=>{
 for(const role of ['inventory_runtime','inventory_auth'])for(const schema of ['inventory','inventory_security']){
 const r=await db.pg.query<{ok:boolean}>('SELECT has_schema_privilege($1,$2,\'CREATE\') ok',[role,schema]);assert.equal(r.rows[0].ok,false);
 }
});
test('Stage12: SECURITY DEFINER functions pin a safe search path',async()=>{
 const rows=(await db.pg.query<{name:string;config:string[]}>(`SELECT p.proname name,p.proconfig config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('inventory','inventory_security') AND p.prosecdef`)).rows;
 assert.ok(rows.length>0);for(const r of rows)assert.ok(r.config?.some(x=>x.startsWith('search_path=')&&x.includes('pg_catalog')),r.name);
});
const origin='https://inventaris.test',token='a'.repeat(64),name=cookieNames(origin).csrf;
function request(cookie:string,site='same-origin',source=origin){return new Request(origin+'/api/test',{method:'POST',headers:{origin:source,'sec-fetch-site':site,cookie,'x-csrf-token':token}})}
test('Stage12: duplicate CSRF cookies fail closed',()=>assert.throws(()=>assertCsrf(request(`${name}=${token}; ${name}=${token}`),origin)));
test('Stage12: valid CSRF cannot authorize cross-site requests',()=>assert.throws(()=>assertCsrf(request(`${name}=${token}`,'cross-site'),origin)));
test('Stage12: valid CSRF cannot authorize a foreign origin',()=>assert.throws(()=>assertCsrf(request(`${name}=${token}`,'same-origin','https://evil.test'),origin)));
test('Stage12: streamed JSON limit applies without Content-Length',async()=>{
 await assert.rejects(()=>readJson(new Request(origin,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:'x'.repeat(100)})}),32),{code:'PAYLOAD_TOO_LARGE'});
});
test('Stage12: streamed JSON limit applies despite forged Content-Length',async()=>{
 await assert.rejects(()=>readJson(new Request(origin,{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body:JSON.stringify({value:'x'.repeat(100)})}),32),{code:'PAYLOAD_TOO_LARGE'});
});
