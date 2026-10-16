#!/usr/bin/env python3
"""Real multi-connection tests. Requires a dedicated disposable PostgreSQL database.
Never run against production. This script inserts and commits TEST_* fixtures.
Set STAGE2_NATIVE_TEST_DATABASE_URL and STAGE2_ALLOW_TEST_FIXTURES=YES.
"""
import os,json,uuid,threading,concurrent.futures
from pathlib import Path
URL=os.getenv('STAGE2_NATIVE_TEST_DATABASE_URL')
if not URL:
 print('NOT_RUN: STAGE2_NATIVE_TEST_DATABASE_URL not set');raise SystemExit(0)
if os.getenv('STAGE2_ALLOW_TEST_FIXTURES')!='YES':raise SystemExit('Refusing fixture writes without STAGE2_ALLOW_TEST_FIXTURES=YES')
try:import psycopg as pg
except ImportError:import psycopg2 as pg
ROOT=Path(__file__).resolve().parents[1]
A='00000000-0000-4000-8000-000000000001';UA='00000000-0000-4000-8000-000000000011';MA='00000000-0000-4000-8000-000000000021'
AS='00000000-0000-4000-8000-000000000051';RA='00000000-0000-4000-8000-000000000041';ITEM='00000000-0000-4000-8000-000000000061';DOC='00000000-0000-4000-8000-000000000071';LI='00000000-0000-4000-8000-000000000091'
results=[]
def conn():
 c=pg.connect(URL)
 with c.cursor() as q:q.execute("SET statement_timeout='15s'; SET lock_timeout='10s'")
 c.commit();return c
# Fresh schema requirement makes accidental reruns on an existing business DB fail safely.
c=conn()
with c.cursor() as q:
 q.execute("SELECT to_regnamespace('inventory')")
 if q.fetchone()[0] is not None:raise SystemExit('Use an EMPTY disposable database: inventory schema already exists')
c.close()
for f in sorted((ROOT/'supabase/migrations').glob('*.sql')):
 c=conn()
 with c.cursor() as q:q.execute(f.read_text())
 c.commit();c.close()
c=conn()
with c.cursor() as q:q.execute((ROOT/'tests/fixtures.sql').read_text())
c.commit();c.close()
def setup(sql,args=()):
 c=conn()
 try:
  with c.cursor() as q:q.execute(sql,args);row=q.fetchone() if q.description else None
  c.commit();return row
 finally:c.close()
def race(sqls,role='inventory_runtime'):
 gate=threading.Barrier(len(sqls))
 def worker(entry):
  c=conn()
  try:
   with c.cursor() as q:
    q.execute('SET LOCAL ROLE '+role)
    q.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true)",(A,UA))
    gate.wait(timeout=15)
    q.execute(*entry);value=q.fetchone() if q.description else None
   c.commit();return {'status':'committed','value':str(value)}
  except Exception as e:
   c.rollback();return {'status':'rejected','sqlstate':getattr(e,'sqlstate',None) or getattr(e,'pgcode',None)}
  finally:c.close()
 with concurrent.futures.ThreadPoolExecutor(max_workers=len(sqls)) as pool:return list(pool.map(worker,sqls))
def record(name,rows,expected_success):
 good=sum(r['status']=='committed' for r in rows)
 ok=good==expected_success and all(r['status']=='committed' or r.get('sqlstate') in ('23514','23505') for r in rows)
 results.append({'name':name,'status':'PASS' if ok else 'FAIL','connections':len(rows),'outcomes':rows});print(results[-1])
# Atomic sequence has unique results under concurrent transactions.
rows=race([("SELECT inventory_security.next_number('native-race',2026)",())]*8)
unique=len({r.get('value') for r in rows})
record('8 concurrent inventory numbers are unique',rows,8)
if unique!=8:results[-1]['status']='FAIL'
# Insert initial stock through guarded interface, never direct balances.
POST='SELECT inventory_security.post_stock(%s,%s,%s,%s,%s,%s,%s,%s)'
setup("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true)",(A,UA)) # settings intentionally transaction-local
c=conn()
with c.cursor() as q:
 q.execute('SET LOCAL ROLE inventory_test_poster')
 q.execute("SELECT set_config('app.tenant_id',%s,true),set_config('app.user_id',%s,true)",(A,UA))
 q.execute(POST,(ITEM,RA,1,10,'receipt',DOC,MA,'native-seed'))
c.commit();c.close()
rows=race([(POST,(ITEM,RA,-1,-10,'issue',DOC,MA,'native-issue-'+str(i))) for i in range(2)],'inventory_test_poster')
record('Two concurrent issues cannot consume the same last unit',rows,1)
balance=setup('SELECT quantity,stock_value FROM inventory.inventory_stock_balances WHERE tenant_id=%s AND item_id=%s',(A,ITEM))
if balance!=(0,0):results[-1]['status']='FAIL'
RES='INSERT INTO inventory.asset_reservations(tenant_id,asset_id,loan_item_id,reserved_by) VALUES(%s,%s,%s,%s)'
rows=race([(RES,(A,AS,LI,MA))]*2);record('Two concurrent reservations produce one active loan reservation',rows,1)
# Last-admin demotions must serialize even when different membership rows are changed.
U2=str(uuid.uuid4());M2=str(uuid.uuid4())
setup("INSERT INTO inventory.app_users(id,sso_user_id,username_snapshot,full_name_snapshot) VALUES(%s,'test_second_admin','test.admin2','Admin Uji 2')",(U2,))
setup("INSERT INTO inventory.tenant_memberships(id,tenant_id,app_user_id,role_id) SELECT %s,%s,%s,id FROM inventory.roles WHERE tenant_id=%s AND code='admin'",(M2,A,U2,A))
# Run as migration-owner to exercise DB constraint independently of self-edit prohibition.
def owner_race(ids):
 gate=threading.Barrier(2)
 def work(mid):
  c=conn()
  try:
   with c.cursor() as q:gate.wait(timeout=15);q.execute("UPDATE inventory.tenant_memberships SET status='inactive' WHERE id=%s",(mid,))
   c.commit();return {'status':'committed'}
  except Exception as e:c.rollback();return {'status':'rejected','sqlstate':getattr(e,'sqlstate',None) or getattr(e,'pgcode',None)}
  finally:c.close()
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(work,ids))
rows=owner_race([MA,M2]);record('Two admin demotions retain one active administrator',rows,1)
report={'engine':setup('SELECT version()')[0],'results':results,'passed':sum(x['status']=='PASS' for x in results),'failed':sum(x['status']=='FAIL' for x in results),'note':'Real independent PostgreSQL connections; test data committed only in explicit disposable DB'}
(ROOT/'docs/VERIFICATION-Native-Concurrency.json').write_text(json.dumps(report,indent=2)+'\n')
raise SystemExit(1 if report['failed'] else 0)
