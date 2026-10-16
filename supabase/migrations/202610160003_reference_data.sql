BEGIN;
INSERT INTO inventory.permissions(code,description) VALUES
 ('dashboard.view','Melihat dashboard'),('assets.view','Melihat aset'),('assets.create','Membuat aset'),('assets.update','Mengubah aset'),('assets.delete','Mengarsip aset'),('assets.export','Mengekspor aset'),
 ('inventory.view','Melihat persediaan'),('inventory.receive','Menerima stok'),('inventory.issue','Mengeluarkan stok'),('inventory.adjust','Penyesuaian stok'),('procurement.manage','Mengelola pengadaan'),
 ('movements.create','Mengajukan mutasi'),('movements.approve','Menyetujui mutasi'),('loans.create','Mengajukan peminjaman'),('loans.approve','Menyetujui peminjaman'),
 ('maintenance.manage','Mengelola pemeliharaan'),('stockopname.execute','Melaksanakan opname'),('stockopname.approve','Menyetujui opname'),('disposal.create','Mengajukan penghapusan'),('disposal.approve','Menyetujui penghapusan'),
 ('depreciation.manage','Mengelola penyusutan'),('reports.view','Melihat laporan'),('reports.export','Mengekspor laporan'),('files.upload','Mengunggah file'),('files.download','Mengunduh file'),
 ('files.sensitive.download','Mengunduh dokumen sensitif'),('users.manage','Mengelola keanggotaan'),('settings.manage','Mengelola pengaturan'),('approval.manage','Mengelola workflow')
ON CONFLICT(code) DO NOTHING;
-- Explicit administrative call after tenant creation; never auto-provisions SSO users.
-- SECURITY INVOKER and not granted to runtime/auth.
CREATE FUNCTION inventory_security.seed_tenant(p_tenant uuid) RETURNS void LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ BEGIN
 PERFORM 1 FROM inventory.tenants WHERE id=p_tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown tenant'; END IF;
 INSERT INTO inventory.roles(tenant_id,code,name) VALUES
 (p_tenant,'admin','Admin Inventaris'),(p_tenant,'petugas','Petugas'),(p_tenant,'viewer','Viewer') ON CONFLICT(tenant_id,code) DO NOTHING;
 INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code)
 SELECT p_tenant,r.id,p.code FROM inventory.roles r CROSS JOIN inventory.permissions p
 WHERE r.tenant_id=p_tenant AND (r.code='admin' OR
 (r.code='petugas' AND p.code IN ('dashboard.view','assets.view','assets.create','assets.update','assets.export','inventory.view','inventory.receive','inventory.issue','procurement.manage','movements.create','loans.create','maintenance.manage','stockopname.execute','disposal.create','reports.view','reports.export','files.upload','files.download')) OR
 (r.code='viewer' AND p.code IN ('dashboard.view','assets.view','inventory.view','reports.view','reports.export')))
 ON CONFLICT(tenant_id,role_id,permission_code) DO NOTHING;
 INSERT INTO inventory.tenant_settings(tenant_id) VALUES(p_tenant) ON CONFLICT(tenant_id) DO NOTHING;
 INSERT INTO inventory.units(tenant_id,code,name) VALUES
 (p_tenant,'UNIT','Unit'),(p_tenant,'BUAH','Buah'),(p_tenant,'SET','Set'),(p_tenant,'PAKET','Paket'),(p_tenant,'RIM','Rim'),(p_tenant,'LEMBAR','Lembar'),(p_tenant,'LITER','Liter'),(p_tenant,'METER','Meter'),(p_tenant,'KG','Kilogram') ON CONFLICT(tenant_id,code) DO NOTHING;
 INSERT INTO inventory.asset_conditions(tenant_id,code,name) VALUES
 (p_tenant,'BAIK','Baik'),(p_tenant,'RUSAK_RINGAN','Rusak Ringan'),(p_tenant,'RUSAK_BERAT','Rusak Berat'),(p_tenant,'PERBAIKAN','Dalam Perbaikan'),(p_tenant,'HILANG','Hilang'),(p_tenant,'TIDAK_LAYAK','Tidak Layak Pakai') ON CONFLICT(tenant_id,code) DO NOTHING;
 INSERT INTO inventory.funding_sources(tenant_id,code,name) VALUES
 (p_tenant,'BOS_BOSP','BOS/BOSP'),(p_tenant,'PEMERINTAH','Bantuan Pemerintah'),(p_tenant,'YAYASAN','Dana Yayasan'),(p_tenant,'KOMITE','Komite'),(p_tenant,'HIBAH','Hibah'),(p_tenant,'DONASI','Donasi'),(p_tenant,'LAINNYA','Sumber Lainnya') ON CONFLICT(tenant_id,code) DO NOTHING;
 INSERT INTO inventory.asset_categories(tenant_id,code,name,asset_kind,depreciable) VALUES
 (p_tenant,'TANAH','Tanah','land',false),(p_tenant,'BANGUNAN','Bangunan dan Gedung','building',true),
 (p_tenant,'KENDARAAN','Kendaraan','vehicle',true),(p_tenant,'PERALATAN','Peralatan dan Mesin','equipment',true),
 (p_tenant,'MEUBELAIR','Meubelair','equipment',true),(p_tenant,'ELEKTRONIK','Elektronik','equipment',true),
 (p_tenant,'BUKU','Buku dan Koleksi','collection',true),(p_tenant,'LAB','Peralatan Laboratorium','equipment',true),
 (p_tenant,'OLAHRAGA','Peralatan Olahraga','equipment',true),(p_tenant,'BELAJAR','Sarana Pembelajaran','equipment',true),
 (p_tenant,'HABIS_PAKAI','Barang Habis Pakai','inventory',false),(p_tenant,'PERSEDIAAN','Persediaan Lainnya','inventory',false)
 ON CONFLICT(tenant_id,code) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION inventory_security.seed_tenant(uuid) FROM PUBLIC;
COMMIT;
