-- DISPOSABLE TEST DATABASE ONLY. These records are not production seed data.
BEGIN;
INSERT INTO inventory.tenants(id,code,name,status) VALUES
 ('00000000-0000-4000-8000-000000000001','TEST_A','Lembaga Uji A','active'),
 ('00000000-0000-4000-8000-000000000002','TEST_B','Lembaga Uji B','active');
SELECT inventory_security.seed_tenant('00000000-0000-4000-8000-000000000001');
SELECT inventory_security.seed_tenant('00000000-0000-4000-8000-000000000002');
INSERT INTO inventory.app_users(id,sso_user_id,username_snapshot,full_name_snapshot) VALUES
 ('00000000-0000-4000-8000-000000000011','test_admin_a','test.admin.a','Admin Uji A'),
 ('00000000-0000-4000-8000-000000000012','test_admin_b','test.admin.b','Admin Uji B'),
 ('00000000-0000-4000-8000-000000000013','test_viewer','test.viewer','Viewer Uji');
INSERT INTO inventory.tenant_memberships(id,tenant_id,app_user_id,role_id) VALUES
 ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011',(SELECT id FROM inventory.roles WHERE tenant_id='00000000-0000-4000-8000-000000000001' AND code='admin')),
 ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000012',(SELECT id FROM inventory.roles WHERE tenant_id='00000000-0000-4000-8000-000000000002' AND code='admin')),
 ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000013',(SELECT id FROM inventory.roles WHERE tenant_id='00000000-0000-4000-8000-000000000001' AND code='viewer'));
INSERT INTO inventory.buildings(id,tenant_id,code,name) VALUES
 ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000001','GDG','Gedung A'),
 ('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000002','GDG','Gedung B');
INSERT INTO inventory.rooms(id,tenant_id,code,name,building_id) VALUES
 ('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000001','R1','Ruang A','00000000-0000-4000-8000-000000000031'),
 ('00000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-000000000002','R1','Ruang B','00000000-0000-4000-8000-000000000032');
INSERT INTO inventory.assets(id,tenant_id,inventory_code,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id)
 SELECT '00000000-0000-4000-8000-000000000051',t.id,'ASET-001','Laptop Uji',c.id,u.id,k.id,CURRENT_DATE,'purchase',10000000,'available','00000000-0000-4000-8000-000000000041'
 FROM inventory.tenants t JOIN inventory.asset_categories c ON c.tenant_id=t.id AND c.code='ELEKTRONIK'
 JOIN inventory.units u ON u.tenant_id=t.id AND u.code='UNIT' JOIN inventory.asset_conditions k ON k.tenant_id=t.id AND k.code='BAIK' WHERE t.code='TEST_A';
INSERT INTO inventory.assets(id,tenant_id,inventory_code,name,category_id,unit_id,condition_id,acquisition_date,acquisition_method,acquisition_cost,lifecycle_status,room_id)
 SELECT '00000000-0000-4000-8000-000000000052',t.id,'ASET-001','Aset B',c.id,u.id,k.id,CURRENT_DATE,'purchase',1000,'available','00000000-0000-4000-8000-000000000042'
 FROM inventory.tenants t JOIN inventory.asset_categories c ON c.tenant_id=t.id AND c.code='ELEKTRONIK'
 JOIN inventory.units u ON u.tenant_id=t.id AND u.code='UNIT' JOIN inventory.asset_conditions k ON k.tenant_id=t.id AND k.code='BAIK' WHERE t.code='TEST_B';
INSERT INTO inventory.inventory_items(id,tenant_id,code,name,unit_id,category_id)
 SELECT '00000000-0000-4000-8000-000000000061',t.id,'KERTAS','Kertas Uji',u.id,c.id FROM inventory.tenants t
 JOIN inventory.units u ON u.tenant_id=t.id AND u.code='RIM' JOIN inventory.asset_categories c ON c.tenant_id=t.id AND c.code='HABIS_PAKAI' WHERE t.code='TEST_A';
INSERT INTO inventory.business_documents(id,tenant_id,document_number,document_type,requested_by,status) VALUES
 ('00000000-0000-4000-8000-000000000071','00000000-0000-4000-8000-000000000001','DOC-1','stock','00000000-0000-4000-8000-000000000021','approved');
INSERT INTO inventory.asset_loans(id,tenant_id,document_number,requested_by,borrower_name,purpose,planned_checkout_at,due_at) VALUES
 ('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000001','LOAN-1','00000000-0000-4000-8000-000000000021','Peminjam Uji','Uji',now(),now()+interval '1 day');
INSERT INTO inventory.asset_loan_items(id,tenant_id,loan_id,line_number,asset_id) VALUES
 ('00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000081',1,'00000000-0000-4000-8000-000000000051');
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='inventory_test_poster') THEN CREATE ROLE inventory_test_poster NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT inventory_runtime TO inventory_test_poster;
GRANT EXECUTE ON FUNCTION inventory_security.post_stock(uuid,uuid,numeric,numeric,text,uuid,uuid,text) TO inventory_test_poster;
COMMIT;
