"""Generate human-readable dictionary from the migrated PostgreSQL catalog."""
import json
from pathlib import Path
from collections import defaultdict
root=Path(__file__).resolve().parents[1]
c=json.loads((root/'docs/catalog-stage11.json').read_text());cols=defaultdict(list);cons=defaultdict(list);idx=defaultdict(list);pol=defaultdict(list)
for x in c['columns']:cols[x['table_name']].append(x)
for x in c['constraints']:cons[x['table_name']].append(x)
for x in c['indexes']:idx[x['tablename']].append(x)
for x in c['policies']:pol[x['tablename']].append(x)
meaning={'id':'Identitas lokal UUID','tenant_id':'Pemilik data lembaga; wajib pada data tenant','created_at':'Waktu pembuatan dari database','updated_at':'Waktu perubahan otomatis','row_version':'Versi untuk optimistic locking','sso_user_id':'Referensi identitas pusat opaque; bukan username','token_digest':'SHA-256 token sesi; bukan token mentah','authorization_version':'Versi hak lokal untuk invalidasi sesi','identity_version':'Versi identitas pusat saat diverifikasi','file_size':'Ukuran byte file; bukan isi file','token_ciphertext':'Token OAuth terenkripsi; hanya server','encryption_key_id':'Identitas kunci enkripsi terpisah','resumable_uri_ciphertext':'URI sesi upload terenkripsi','quantity_delta':'Perubahan kuantitas ledger bertanda','value_delta':'Perubahan nilai ledger desimal','quantity':'Kuantitas desimal','stock_value':'Saldo nilai persediaan desimal','code':'Kode referensi unik dalam scope terkait','name':'Nama tampilan','status':'Status sesuai CHECK constraint','role_id':'Role lokal pada tenant yang sama','app_user_id':'Identitas lokal pengguna','expires_at':'Batas waktu absolut','idle_expires_at':'Batas idle sesi','last_sso_check_at':'Waktu status pusat terakhir sukses','public_id':'Identitas URL/QR; bukan bukti izin','inventory_code':'Kode inventaris unik per tenant','acquisition_cost':'Nilai perolehan desimal','residual_value':'Nilai residu minimum','period':'Periode terkait; lihat CHECK tanggal','amount':'Nominal desimal','book_value_after':'Nilai buku setelah posting','correction_of':'Referensi entry koreksi tenant/aset sama','posting_key':'Kunci unik untuk mencegah posting ulang','idempotency_key':'Kunci operasi berulang dalam scope tenant','workflow_snapshot':'Snapshot workflow saat diajukan','payload_snapshot':'Snapshot substansi transaksi saat diajukan','expected_room_id':'Ruangan snapshot opname','observed_room_id':'Ruangan hasil pemeriksaan fisik','google_file_id':'ID fisik file pada Google Drive','root_folder_id':'Root folder Drive yang diotorisasi','connection_version':'Versi koneksi Drive tenant','loan_allowed':'Kondisi diizinkan untuk reservasi pinjaman','details':'Metadata audit tersanitasi; bukan salinan penuh data','lease_expires_at':'Batas lease proses konkuren','confirmed_offset':'Jumlah byte yang telah dikonfirmasi Drive'}
def esc(s):return str(s).replace('|','\\|').replace('\n',' ')
def dtype(x):
 if x['data_type']=='numeric':return f"numeric({x['numeric_precision']},{x['numeric_scale']})"
 return x['data_type']
lines=['# Kamus Data PostgreSQL — Tahap 11','',f"Sumber: katalog database setelah tiga belas migration berhasil diterapkan pada PGlite. {len(cols)} tabel, {len(c['columns'])} kolom, {len(c['constraints'])} constraint dan {len(c['indexes'])} indeks.",'','Kolom dan constraint di bawah adalah schema aktual; bukan hanya daftar rencana. Nama kolom SQL dipertahankan agar dapat dicocokkan langsung. Kewenangan bisnis tetap diperiksa backend. Default bukan bukti nilai produksi sudah diisi.','', '## Daftar tabel','', '| Tabel | Scope | Kolom |','| --- | --- | --- |']
for t,x in cols.items():lines.append(f"| {t} | {'Tenant' if any(k['column_name']=='tenant_id' for k in x) else 'Global/identitas terbatas; lihat README'} | {len(x)} |")
for t,x in cols.items():
 lines += ['',f'## {t}','','| Kolom | Tipe SQL | Nullable | Default | Makna |','| --- | --- | --- | --- | --- |']
 for k in x:
  key=k['column_name'];desc=meaning.get(key,'Referensi entitas; lihat foreign key' if key.endswith('_id') else 'Data domain; lihat constraint dan penjelasan modul')
  lines.append('| '+' | '.join(esc(v) for v in [key,dtype(k),k['is_nullable'],k['column_default'] or '—',desc])+' |')
 lines+=['','Constraint:','']
 for k in cons[t]:lines.append('- `'+esc(k['definition'])+'`')
 lines+=['','Indeks:','']
 for k in idx[t]:lines.append('- `'+esc(k['indexdef'])+'`')
 lines+=['','Policy RLS:','']
 for k in pol[t]:lines.append('- `'+k['policyname']+'` untuk `'+esc(k['roles'])+'`: USING `'+esc(k['qual'])+'`; WITH CHECK `'+esc(k['with_check'])+'`.')
(root/'docs/Kamus-Data-Tahap-11.md').write_text('\n'.join(lines)+'\n')
print('Dictionary written:',len(cols),'tables;',len(c['indexes']),'indexes')
