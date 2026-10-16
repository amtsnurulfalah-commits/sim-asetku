#!/usr/bin/env python3
"""Apply ordered migrations to an explicit target, with checksums and no destructive reset.
Requires psycopg (v3) or psycopg2. DATABASE_URL is read only from environment.
"""
import os,hashlib
from pathlib import Path
try:import psycopg as pg
except ImportError:import psycopg2 as pg
url=os.environ.get('MIGRATION_DATABASE_URL') or os.environ.get('DATABASE_URL')
if not url:raise SystemExit('Set MIGRATION_DATABASE_URL for the intended sandbox/staging target.')
c=pg.connect(url);c.autocommit=True
try:
 with c.cursor() as q:
  q.execute('SELECT pg_advisory_lock(8461037201)')
  q.execute('CREATE SCHEMA IF NOT EXISTS inventory_migrations')
  q.execute('REVOKE ALL ON SCHEMA inventory_migrations FROM PUBLIC')
  q.execute('CREATE TABLE IF NOT EXISTS inventory_migrations.history(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())')
  for f in sorted((Path(__file__).resolve().parents[1]/'supabase/migrations').glob('*.sql')):
   sql=f.read_text();sha=hashlib.sha256(f.read_bytes()).hexdigest()
   q.execute('SELECT sha256 FROM inventory_migrations.history WHERE name=%s',(f.name,));old=q.fetchone()
   if old:
    if old[0]!=sha:raise RuntimeError('Applied migration checksum mismatch: '+f.name)
    print('SKIP',f.name);continue
   # Each SQL file has BEGIN/COMMIT. History is appended before that same COMMIT.
   marker=sql.rfind('COMMIT;')
   if marker<0:raise RuntimeError('Migration must end with COMMIT: '+f.name)
   q.execute(sql[:marker])
   q.execute('INSERT INTO inventory_migrations.history(name,sha256) VALUES(%s,%s)',(f.name,sha))
   q.execute('COMMIT')
   print('APPLIED',f.name)
finally:
 # Closing connection releases lock, including on error. Do not log connection strings.
 c.close()
