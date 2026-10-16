BEGIN;
ALTER TABLE inventory.tenant_settings ADD COLUMN supply_review_mode text NOT NULL DEFAULT 'disabled' CHECK(supply_review_mode IN ('disabled','single_admin_v1'));
ALTER TABLE inventory.inventory_items ADD COLUMN valuation_method text NOT NULL DEFAULT 'moving_average' CHECK(valuation_method='moving_average');
ALTER TABLE inventory.business_documents ADD COLUMN supply_kind text CHECK(supply_kind IN ('request','order','receipt','receipt_stock','issue','adjustment'));
ALTER TABLE inventory.business_documents ADD COLUMN supply_reason text;
ALTER TABLE inventory.business_documents ADD COLUMN review_mode_snapshot text;
ALTER TABLE inventory.business_documents ADD COLUMN input_snapshot jsonb;
ALTER TABLE inventory.inventory_adjustments ADD COLUMN transaction_kind text CHECK(transaction_kind IN ('receipt_stock','issue','adjustment'));
ALTER TABLE inventory.inventory_adjustments ADD COLUMN corrects_document_id uuid;
ALTER TABLE inventory.inventory_adjustments ADD FOREIGN KEY(tenant_id,corrects_document_id) REFERENCES inventory.business_documents(tenant_id,id);
ALTER TABLE inventory.procurement_request_items ADD UNIQUE(tenant_id,id,request_id);
ALTER TABLE inventory.procurements ADD UNIQUE(tenant_id,id,request_id);
ALTER TABLE inventory.procurement_items ADD COLUMN request_item_id uuid;
ALTER TABLE inventory.procurement_items ADD COLUMN request_id uuid;
ALTER TABLE inventory.procurement_items ADD COLUMN inventory_item_id uuid;
ALTER TABLE inventory.procurement_items ADD COLUMN asset_template jsonb;
ALTER TABLE inventory.procurement_items ADD FOREIGN KEY(tenant_id,request_item_id,request_id) REFERENCES inventory.procurement_request_items(tenant_id,id,request_id);
ALTER TABLE inventory.procurement_items ADD FOREIGN KEY(tenant_id,procurement_id,request_id) REFERENCES inventory.procurements(tenant_id,id,request_id);
ALTER TABLE inventory.procurement_items ADD FOREIGN KEY(tenant_id,inventory_item_id) REFERENCES inventory.inventory_items(tenant_id,id);
ALTER TABLE inventory.goods_receipt_items ADD COLUMN inspection_notes text;
CREATE TABLE inventory.inventory_transaction_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),adjustment_id uuid NOT NULL,
 line_number integer NOT NULL CHECK(line_number>0),item_id uuid NOT NULL,room_id uuid NOT NULL,
 quantity_delta numeric(20,6) NOT NULL CHECK(quantity_delta<>0),unit_cost numeric(20,6) NOT NULL CHECK(unit_cost>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,adjustment_id,line_number),
 FOREIGN KEY(tenant_id,adjustment_id) REFERENCES inventory.inventory_adjustments(tenant_id,id),
 FOREIGN KEY(tenant_id,item_id) REFERENCES inventory.inventory_items(tenant_id,id),FOREIGN KEY(tenant_id,room_id) REFERENCES inventory.rooms(tenant_id,id)
);
CREATE TABLE inventory.supply_review_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),document_id uuid,
 actor_id uuid NOT NULL,action text NOT NULL,reason text NOT NULL,revision integer,content_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES inventory.business_documents(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
CREATE TABLE inventory.receipt_asset_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),receipt_item_id uuid NOT NULL,asset_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,asset_id),
 FOREIGN KEY(tenant_id,receipt_item_id) REFERENCES inventory.goods_receipt_items(tenant_id,id),FOREIGN KEY(tenant_id,asset_id) REFERENCES inventory.assets(tenant_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['inventory_transaction_lines','supply_review_events','receipt_asset_links'] LOOP
 EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY migration_owner ON inventory.%I TO %I USING(true) WITH CHECK(true)',tab,current_user);
 EXECUTE format('CREATE POLICY tenant_scope ON inventory.%I TO inventory_runtime USING(tenant_id=inventory_security.tenant_id())',tab);
 EXECUTE format('GRANT SELECT ON inventory.%I TO inventory_runtime',tab);
 -- Transaction lines are replaced only while a document is draft by the constrained owner function.
 IF tab<>'inventory_transaction_lines' THEN EXECUTE format('CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite()',tab);END IF;
 EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.audit_change()',tab);
 EXECUTE format('CREATE INDEX ON inventory.%I(tenant_id,created_at,id)',tab);
 END LOOP;
END $$;
CREATE INDEX ON inventory.inventory_transaction_lines(tenant_id,adjustment_id);
CREATE INDEX ON inventory.supply_review_events(tenant_id,document_id,created_at);
CREATE INDEX ON inventory.receipt_asset_links(tenant_id,receipt_item_id);
ALTER TABLE inventory.inventory_stock_ledger ADD COLUMN posting_sequence bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE inventory.inventory_stock_ledger ADD COLUMN transaction_line_id uuid;
ALTER TABLE inventory.inventory_stock_ledger ADD FOREIGN KEY(tenant_id,transaction_line_id) REFERENCES inventory.inventory_transaction_lines(tenant_id,id);
CREATE INDEX ON inventory.inventory_stock_ledger(tenant_id,item_id,room_id,posting_sequence);
CREATE INDEX ON inventory.business_documents(tenant_id,supply_kind,status,created_at);
CREATE FUNCTION inventory_security.assert_supply_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission IN ('settings.manage','approval.manage') THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('inventory.view','inventory.receive','inventory.issue','inventory.adjust','procurement.manage','assets.create','files.upload','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
PERFORM 1 FROM inventory.tenants WHERE id=t AND status='active' FOR SHARE;
IF NOT FOUND THEN RAISE EXCEPTION 'Active tenant required' USING ERRCODE='42501'; END IF;
SELECT * INTO s FROM inventory.app_sessions WHERE app_user_id=u AND token_digest=nullif(current_setting('app.session_digest',true),'');
IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.idle_expires_at<=clock_timestamp() OR s.active_tenant_id IS DISTINCT FROM t OR s.active_membership_id IS DISTINCT FROM nullif(current_setting('app.membership_id',true),'')::uuid THEN RAISE EXCEPTION 'Session denied' USING ERRCODE='42501'; END IF;
SELECT * INTO m FROM inventory.tenant_memberships WHERE tenant_id=t AND id=s.active_membership_id AND app_user_id=u AND status='active';
IF NOT FOUND OR m.authorization_version<>s.authorization_version OR NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active')
OR NOT EXISTS(SELECT FROM inventory.sso_status_cache WHERE app_user_id=u AND can_authenticate AND identity_version=s.identity_version AND valid_until>clock_timestamp())
OR NOT(EXISTS(SELECT FROM inventory.role_permissions WHERE tenant_id=t AND role_id=m.role_id AND permission_code=p_permission)
OR EXISTS(SELECT FROM inventory.membership_permission_grants WHERE tenant_id=t AND membership_id=m.id AND permission_code=p_permission AND (expires_at IS NULL OR expires_at>clock_timestamp()))) THEN RAISE EXCEPTION 'Asset actor denied' USING ERRCODE='42501'; END IF;
RETURN m.id; END $$;
REVOKE ALL ON FUNCTION inventory_security.assert_supply_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_supply_actor(text) TO inventory_runtime;
CREATE FUNCTION inventory_security.supply_policy(p_mode text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE actor uuid;BEGIN
actor:=inventory_security.assert_tenant_admin();IF p_mode NOT IN ('disabled','single_admin_v1') OR length(btrim(p_reason))<3 THEN RAISE EXCEPTION 'Invalid policy' USING ERRCODE='23514';END IF;
UPDATE inventory.tenant_settings SET supply_review_mode=p_mode WHERE tenant_id=inventory_security.tenant_id();
INSERT INTO inventory.supply_review_events(tenant_id,actor_id,action,reason) VALUES(inventory_security.tenant_id(),actor,'policy:'||p_mode,p_reason);END $$;
CREATE FUNCTION inventory_security.supply_master(p_kind text,p_id uuid,p_version bigint,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();result uuid;BEGIN
PERFORM inventory_security.assert_tenant_admin();
IF p_kind='item' THEN
 IF p_id IS NOT NULL AND p_data->>'status'='archived' AND EXISTS(SELECT FROM inventory.inventory_stock_balances WHERE tenant_id=t AND item_id=p_id AND quantity>0) THEN RAISE EXCEPTION 'Clear stock before archive' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM inventory.asset_categories WHERE tenant_id=t AND id=(p_data->>'categoryId')::uuid AND asset_kind='inventory' AND status='active') OR NOT EXISTS(SELECT FROM inventory.units WHERE tenant_id=t AND id=(p_data->>'unitId')::uuid AND status='active') THEN RAISE EXCEPTION 'Active inventory category/unit required' USING ERRCODE='23514';END IF;
 IF p_id IS NULL THEN INSERT INTO inventory.inventory_items(tenant_id,code,name,status,unit_id,category_id,minimum_stock) VALUES(t,p_data->>'code',p_data->>'name',p_data->>'status',(p_data->>'unitId')::uuid,(p_data->>'categoryId')::uuid,(p_data->>'minimumStock')::numeric) RETURNING id INTO result;
 ELSE
 IF EXISTS(SELECT FROM inventory.inventory_stock_ledger WHERE tenant_id=t AND item_id=p_id) AND EXISTS(SELECT FROM inventory.inventory_items WHERE tenant_id=t AND id=p_id AND unit_id<>(p_data->>'unitId')::uuid) THEN RAISE EXCEPTION 'Used base unit immutable' USING ERRCODE='23514';END IF;
 UPDATE inventory.inventory_items SET code=p_data->>'code',name=p_data->>'name',status=p_data->>'status',unit_id=(p_data->>'unitId')::uuid,category_id=(p_data->>'categoryId')::uuid,minimum_stock=(p_data->>'minimumStock')::numeric WHERE tenant_id=t AND id=p_id AND row_version=p_version RETURNING id INTO result;
 END IF;
ELSIF p_kind='supplier' THEN
 IF p_id IS NULL THEN INSERT INTO inventory.suppliers(tenant_id,code,name,status) VALUES(t,p_data->>'code',p_data->>'name',p_data->>'status') RETURNING id INTO result;
 ELSE UPDATE inventory.suppliers SET code=p_data->>'code',name=p_data->>'name',status=p_data->>'status' WHERE tenant_id=t AND id=p_id AND row_version=p_version RETURNING id INTO result;END IF;
ELSE RAISE EXCEPTION 'Unknown master' USING ERRCODE='23514';END IF;
IF result IS NULL THEN RAISE EXCEPTION 'Stale master' USING ERRCODE='40001';END IF;RETURN result;END $$;
CREATE FUNCTION inventory_security.supply_source(p_kind text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE p_kind WHEN 'request' THEN 'procurement_requests' WHEN 'order' THEN 'procurements' WHEN 'receipt' THEN 'goods_receipts' WHEN 'receipt_stock' THEN 'inventory_adjustments' WHEN 'issue' THEN 'inventory_adjustments' WHEN 'adjustment' THEN 'inventory_adjustments' END $$;
CREATE FUNCTION inventory_security.supply_permission(p_kind text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE p_kind WHEN 'request' THEN 'procurement.manage' WHEN 'order' THEN 'procurement.manage' WHEN 'receipt' THEN 'inventory.receive' WHEN 'receipt_stock' THEN 'inventory.receive' WHEN 'issue' THEN 'inventory.issue' WHEN 'adjustment' THEN 'inventory.adjust' END $$;
CREATE FUNCTION inventory_security.supply_save(p_id uuid,p_version bigint,p_key uuid,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;k text:=p_data->>'kind';tab text;doc inventory.business_documents;source uuid;bid uuid;num text;digest text;prior inventory.idempotency_records;l jsonb;idx integer:=0;total numeric:=0;rid uuid;pi inventory.procurement_request_items;ord inventory.procurements;oi inventory.procurement_items;qty numeric;accepted numeric;cost numeric;reqid uuid;item inventory.inventory_items;
BEGIN
actor:=inventory_security.assert_supply_actor(inventory_security.supply_permission(k));tab:=inventory_security.supply_source(k);
IF tab IS NULL OR p_key IS NULL OR jsonb_array_length(p_data->'lines') NOT BETWEEN 1 AND 50 OR length(btrim(p_data->>'reason'))<3 OR (p_data->>'date')::date>(SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM inventory.tenants WHERE id=t) THEN RAISE EXCEPTION 'Invalid document' USING ERRCODE='23514';END IF;
digest:=encode(sha256(convert_to(p_data::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended(t::text||p_key::text,0));
SELECT * INTO prior FROM inventory.idempotency_records WHERE tenant_id=t AND operation='supply.save' AND idempotency_key=p_key::text;
IF FOUND THEN IF prior.request_digest<>digest THEN RAISE EXCEPTION 'Idempotency mismatch' USING ERRCODE='23514';END IF;RETURN prior.resource_id;END IF;
IF p_id IS NOT NULL THEN
 SELECT * INTO doc FROM inventory.business_documents WHERE tenant_id=t AND id=p_id AND supply_kind=k FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF doc.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
 IF doc.requested_by<>actor OR doc.status NOT IN ('draft','revision_required') THEN RAISE EXCEPTION 'Only owner editable draft' USING ERRCODE='42501';END IF;
 bid:=doc.id;num:=doc.document_number;
 EXECUTE format('SELECT id FROM inventory.%I WHERE tenant_id=$1 AND business_document_id=$2 FOR UPDATE',tab) INTO source USING t,bid;
 IF k='request' AND EXISTS(SELECT FROM inventory.procurements WHERE tenant_id=t AND request_id=source) THEN RAISE EXCEPTION 'Request already used' USING ERRCODE='23514';END IF;
 IF k='order' AND EXISTS(SELECT FROM inventory.goods_receipts WHERE tenant_id=t AND procurement_id=source) THEN RAISE EXCEPTION 'Order already used' USING ERRCODE='23514';END IF;
ELSE
 num:=upper(k)||'/'||inventory_security.next_number('supply:'||k,0)::text;
 INSERT INTO inventory.business_documents(tenant_id,document_number,business_date,requested_by,document_type,supply_kind,supply_reason,input_snapshot) VALUES(t,num,(p_data->>'date')::date,actor,'supply:'||k,k,p_data->>'reason',p_data) RETURNING id INTO bid;
END IF;
IF k IN ('request','order') AND p_data->>'fundingId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.funding_sources WHERE tenant_id=t AND id=(p_data->>'fundingId')::uuid AND status='active') THEN RAISE EXCEPTION 'Inactive funding source' USING ERRCODE='23514';END IF;
IF k='request' THEN
 IF NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(p_data->>'roomId')::uuid AND status='active') THEN RAISE EXCEPTION 'Active room required' USING ERRCODE='23514';END IF;
 IF source IS NULL THEN INSERT INTO inventory.procurement_requests(tenant_id,document_number,business_date,requested_by,funding_source_id,request_room_id,business_document_id) VALUES(t,num,(p_data->>'date')::date,actor,(p_data->>'fundingId')::uuid,(p_data->>'roomId')::uuid,bid) RETURNING id INTO source;
 ELSE DELETE FROM inventory.procurement_request_items WHERE tenant_id=t AND request_id=source;UPDATE inventory.procurement_requests SET business_date=(p_data->>'date')::date,funding_source_id=(p_data->>'fundingId')::uuid,request_room_id=(p_data->>'roomId')::uuid WHERE id=source;END IF;
ELSIF k='order' THEN
 reqid:=(p_data->>'requestId')::uuid;
 PERFORM 1 FROM inventory.procurement_requests WHERE tenant_id=t AND id=reqid AND status='approved' AND business_date<=(p_data->>'date')::date FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM inventory.suppliers WHERE tenant_id=t AND id=(p_data->>'supplierId')::uuid AND status='active') THEN RAISE EXCEPTION 'Approved request and active supplier required' USING ERRCODE='23514';END IF;
 IF source IS NULL THEN INSERT INTO inventory.procurements(tenant_id,document_number,business_date,requested_by,request_id,supplier_id,funding_source_id,total_amount,business_document_id) VALUES(t,num,(p_data->>'date')::date,actor,reqid,(p_data->>'supplierId')::uuid,(p_data->>'fundingId')::uuid,0,bid) RETURNING id INTO source;
 ELSE DELETE FROM inventory.procurement_items WHERE tenant_id=t AND procurement_id=source;UPDATE inventory.procurements SET business_date=(p_data->>'date')::date,request_id=reqid,supplier_id=(p_data->>'supplierId')::uuid,funding_source_id=(p_data->>'fundingId')::uuid WHERE id=source;END IF;
ELSIF k='receipt' THEN
 SELECT * INTO ord FROM inventory.procurements WHERE tenant_id=t AND id=(p_data->>'orderId')::uuid AND status='approved' AND business_date<=(p_data->>'date')::date FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved uncompleted order required' USING ERRCODE='23514';END IF;
 IF source IS NULL THEN INSERT INTO inventory.goods_receipts(tenant_id,document_number,business_date,requested_by,procurement_id,business_document_id) VALUES(t,num,(p_data->>'date')::date,actor,ord.id,bid) RETURNING id INTO source;
 ELSE DELETE FROM inventory.goods_receipt_items WHERE tenant_id=t AND receipt_id=source;UPDATE inventory.goods_receipts SET business_date=(p_data->>'date')::date,procurement_id=ord.id WHERE id=source;END IF;
ELSE
 IF p_data->>'correctsDocumentId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.business_documents WHERE tenant_id=t AND id=(p_data->>'correctsDocumentId')::uuid AND status='posted') THEN RAISE EXCEPTION 'Correction source must be posted' USING ERRCODE='23514';END IF;
 IF source IS NULL THEN INSERT INTO inventory.inventory_adjustments(tenant_id,document_number,business_date,requested_by,reason,business_document_id,transaction_kind,corrects_document_id) VALUES(t,num,(p_data->>'date')::date,actor,p_data->>'reason',bid,k,(p_data->>'correctsDocumentId')::uuid) RETURNING id INTO source;
 ELSE DELETE FROM inventory.inventory_transaction_lines WHERE tenant_id=t AND adjustment_id=source;UPDATE inventory.inventory_adjustments SET business_date=(p_data->>'date')::date,reason=p_data->>'reason',corrects_document_id=(p_data->>'correctsDocumentId')::uuid WHERE id=source;END IF;
END IF;
FOR l IN SELECT value FROM jsonb_array_elements(p_data->'lines') LOOP
 idx:=idx+1;qty:=(l->>'quantity')::numeric;cost:=coalesce((l->>'unitCost')::numeric,0);
 IF qty=0 OR cost<0 OR length(coalesce(l->>'description','x'))>1000 THEN RAISE EXCEPTION 'Invalid line quantity/cost' USING ERRCODE='23514';END IF;
 IF k IN ('request','order') AND (qty<=0 OR NOT EXISTS(SELECT FROM inventory.units WHERE tenant_id=t AND id=(l->>'unitId')::uuid AND status='active')) THEN RAISE EXCEPTION 'Active unit and positive quantity required' USING ERRCODE='23514';END IF;
 IF k='request' THEN
 INSERT INTO inventory.procurement_request_items(tenant_id,request_id,line_number,description,unit_id,quantity,estimated_unit_cost) VALUES(t,source,idx,l->>'description',(l->>'unitId')::uuid,qty,cost);total:=total+round(qty*cost,2);
 ELSIF k='order' THEN
 SELECT * INTO pi FROM inventory.procurement_request_items WHERE tenant_id=t AND id=(l->>'requestItemId')::uuid AND request_id=reqid;
 IF NOT FOUND OR pi.unit_id<>(l->>'unitId')::uuid OR qty+coalesce((SELECT sum(i.quantity) FROM inventory.procurement_items i JOIN inventory.procurements p ON p.tenant_id=i.tenant_id AND p.id=i.procurement_id WHERE i.tenant_id=t AND i.request_item_id=pi.id AND p.status<>'cancelled'),0)>pi.quantity THEN RAISE EXCEPTION 'Requested quantity or unit mismatch' USING ERRCODE='23514';END IF;
 IF l->>'destination'='inventory' THEN
 SELECT * INTO item FROM inventory.inventory_items WHERE tenant_id=t AND id=(l->>'itemId')::uuid AND status='active';IF NOT FOUND OR item.unit_id<>pi.unit_id THEN RAISE EXCEPTION 'Inventory base unit mismatch' USING ERRCODE='23514';END IF;
 ELSIF l->>'destination'='asset' THEN
 IF qty<>trunc(qty) OR round(cost,2)<>cost OR l->'asset' IS NULL OR l->'asset'='null'::jsonb OR (l->'asset'->>'unit_id')::uuid<>pi.unit_id THEN RAISE EXCEPTION 'Individual asset unit/template/cost invalid' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Invalid destination' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.procurement_items(tenant_id,procurement_id,line_number,description,unit_id,quantity,unit_cost,destination_kind,request_item_id,request_id,inventory_item_id,asset_template) VALUES(t,source,idx,l->>'description',pi.unit_id,qty,cost,l->>'destination',pi.id,reqid,(l->>'itemId')::uuid,l->'asset');total:=total+round(qty*cost,2);
 ELSIF k='receipt' THEN
 SELECT * INTO oi FROM inventory.procurement_items WHERE tenant_id=t AND procurement_id=ord.id AND id=(l->>'orderItemId')::uuid;accepted:=(l->>'accepted')::numeric;
 IF NOT FOUND OR qty<=0 OR accepted<0 OR accepted>qty OR qty>oi.quantity-oi.received_quantity OR NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(l->>'roomId')::uuid AND status='active') OR length(btrim(l->>'inspection'))<3 OR oi.destination_kind='asset' AND (qty<>trunc(qty) OR accepted<>trunc(accepted) OR accepted>50) THEN RAISE EXCEPTION 'Invalid inspected receipt quantity/room' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM inventory.goods_receipt_items WHERE tenant_id=t AND receipt_id=source AND procurement_item_id=oi.id) THEN RAISE EXCEPTION 'Duplicate receipt line' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.goods_receipt_items(tenant_id,receipt_id,line_number,procurement_item_id,quantity,accepted_quantity,room_id,posting_key,procurement_id,inspection_notes) VALUES(t,source,idx,oi.id,qty,accepted,(l->>'roomId')::uuid,bid::text||':'||idx,ord.id,l->>'inspection');
 ELSE
 IF NOT EXISTS(SELECT FROM inventory.inventory_items WHERE tenant_id=t AND id=(l->>'itemId')::uuid AND status='active') OR NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(l->>'roomId')::uuid AND status='active') OR k='issue' AND qty>=0 OR k='receipt_stock' AND qty<=0 THEN RAISE EXCEPTION 'Invalid stock line/reference/sign' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM inventory.inventory_transaction_lines WHERE tenant_id=t AND adjustment_id=source AND item_id=(l->>'itemId')::uuid AND room_id=(l->>'roomId')::uuid) THEN RAISE EXCEPTION 'Duplicate stock location line' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.inventory_transaction_lines(tenant_id,adjustment_id,line_number,item_id,room_id,quantity_delta,unit_cost) VALUES(t,source,idx,(l->>'itemId')::uuid,(l->>'roomId')::uuid,qty,cost);
 END IF;
END LOOP;
IF k='order' THEN UPDATE inventory.procurements SET total_amount=total WHERE id=source;END IF;
IF p_id IS NOT NULL THEN UPDATE inventory.business_documents SET business_date=(p_data->>'date')::date,supply_reason=p_data->>'reason',input_snapshot=p_data,revision=revision+1,source_revision=source_revision+1,status='draft',review_mode_snapshot=NULL WHERE id=bid;EXECUTE format('UPDATE inventory.%I SET status=''draft'',revision=revision+1 WHERE id=$1',tab) USING source;END IF;
INSERT INTO inventory.supply_review_events(tenant_id,document_id,actor_id,action,reason,revision,content_digest) SELECT t,bid,actor,'save',p_data->>'reason',revision,digest FROM inventory.business_documents WHERE id=bid;
INSERT INTO inventory.idempotency_records(tenant_id,operation,idempotency_key,request_digest,resource_id,expires_at) VALUES(t,'supply.save',p_key::text,digest,bid,clock_timestamp()+interval '10 years');RETURN bid;
END $$;
CREATE FUNCTION inventory_security.supply_transition(p_id uuid,p_version bigint,p_action text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;actor uuid;state text;tab text;mode text;source uuid;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id AND supply_kind IS NOT NULL FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_supply_actor(CASE WHEN p_action IN ('review','approve','reject','revision') THEN 'approval.manage' ELSE inventory_security.supply_permission(d.supply_kind) END);
IF d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
IF length(btrim(p_reason))<3 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514';END IF;
SELECT supply_review_mode INTO mode FROM inventory.tenant_settings WHERE tenant_id=t;
IF p_action='submit' THEN
 IF d.status<>'draft' OR d.requested_by<>actor OR mode<>'single_admin_v1' THEN RAISE EXCEPTION 'Explicit review policy and owner draft required' USING ERRCODE='42501';END IF;
 -- A configured general approval workflow must never be silently bypassed by the interim policy.
 IF EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (d.document_type,d.supply_kind,CASE d.supply_kind WHEN 'request' THEN 'procurement_request' WHEN 'order' THEN 'procurement' WHEN 'receipt' THEN 'goods_receipt' ELSE 'inventory_adjustment' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
 state:='submitted';
ELSIF p_action IN ('review','approve','reject','revision') THEN
 IF d.requested_by=actor OR d.review_mode_snapshot IS DISTINCT FROM 'single_admin_v1' THEN RAISE EXCEPTION 'Independent reviewer required' USING ERRCODE='42501';END IF;
 IF p_action IN ('review','approve') AND EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (d.document_type,d.supply_kind,CASE d.supply_kind WHEN 'request' THEN 'procurement_request' WHEN 'order' THEN 'procurement' WHEN 'receipt' THEN 'goods_receipt' ELSE 'inventory_adjustment' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
 IF p_action='review' AND d.status='submitted' THEN state:='pending';
 ELSIF d.status='pending' THEN state:=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'revision' THEN 'revision_required' END;
 END IF;
ELSIF p_action='cancel' THEN
 IF d.status NOT IN ('draft','submitted','pending','revision_required','rejected') OR d.requested_by<>actor THEN RAISE EXCEPTION 'Not cancellable' USING ERRCODE='42501';END IF;state:='cancelled';
END IF;
IF state IS NULL THEN RAISE EXCEPTION 'Invalid workflow transition' USING ERRCODE='23514';END IF;
UPDATE inventory.business_documents SET status=state,review_mode_snapshot=CASE WHEN p_action='submit' THEN mode ELSE review_mode_snapshot END WHERE id=d.id;
tab:=inventory_security.supply_source(d.supply_kind);EXECUTE format('UPDATE inventory.%I SET status=$1 WHERE tenant_id=$2 AND business_document_id=$3',tab) USING state,t,d.id;
INSERT INTO inventory.supply_review_events(tenant_id,document_id,actor_id,action,reason,revision,content_digest) VALUES(t,d.id,actor,p_action,p_reason,d.revision,encode(sha256(convert_to(d.input_snapshot::text,'UTF8')),'hex'));
END $$;
-- Private stock writer: locks the item/location bucket and computes moving average on the server.
CREATE FUNCTION inventory_security.supply_stock(p_item uuid,p_room uuid,p_qty numeric,p_cost numeric,p_kind text,p_doc uuid,p_key text,p_line uuid DEFAULT NULL,p_value numeric DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();a uuid;bal inventory.inventory_stock_balances;v numeric;result uuid;BEGIN
 a:=inventory_security.assert_supply_actor(CASE p_kind WHEN 'receipt' THEN 'inventory.receive' WHEN 'issue' THEN 'inventory.issue' ELSE 'inventory.adjust' END);
 IF NOT EXISTS(SELECT FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc AND status='approved' AND supply_kind IS NOT NULL) OR p_qty=0 OR p_cost<0 OR p_kind NOT IN ('receipt','issue','adjustment') THEN RAISE EXCEPTION 'Approved stock source required' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM inventory.inventory_items WHERE tenant_id=t AND id=p_item AND status='active') OR NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=p_room AND status='active') THEN RAISE EXCEPTION 'Active stock references required' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.inventory_stock_balances(tenant_id,item_id,room_id) VALUES(t,p_item,p_room) ON CONFLICT(tenant_id,item_id,room_id) DO NOTHING;
 SELECT * INTO bal FROM inventory.inventory_stock_balances WHERE tenant_id=t AND item_id=p_item AND room_id=p_room FOR UPDATE;
 IF bal.quantity+p_qty<0 THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='23514';END IF;
 IF p_qty<0 THEN v:=CASE WHEN -p_qty=bal.quantity THEN -bal.stock_value ELSE -round(bal.stock_value*(-p_qty)/bal.quantity,2) END;
 ELSE v:=coalesce(p_value,round(p_qty*p_cost,2));END IF;
 INSERT INTO inventory.inventory_stock_ledger(tenant_id,item_id,room_id,quantity_delta,value_delta,kind,source_document_id,actor_id,posting_key,transaction_line_id) VALUES(t,p_item,p_room,p_qty,v,p_kind,p_doc,a,p_key,p_line) RETURNING id INTO result;
 RETURN result;END $$;
CREATE FUNCTION inventory_security.supply_post(p_id uuid,p_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;actor uuid;source uuid;tab text;l record;oi inventory.procurement_items;ord inventory.procurements;created jsonb;asset_id uuid;template jsonb;line_value numeric;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR SHARE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id AND supply_kind IS NOT NULL FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_supply_actor(inventory_security.supply_permission(d.supply_kind));
IF d.supply_kind IN ('request','order') OR p_key IS NULL THEN RAISE EXCEPTION 'Only receipts and stock transactions are postable' USING ERRCODE='23514';END IF;
IF d.status='posted' THEN RETURN jsonb_build_object('posted',true,'reused',true);END IF;
IF d.status<>'approved' OR d.review_mode_snapshot IS DISTINCT FROM 'single_admin_v1' OR NOT EXISTS(SELECT FROM inventory.supply_review_events WHERE tenant_id=t AND document_id=d.id AND revision=d.revision AND action='approve' AND actor_id<>d.requested_by) THEN RAISE EXCEPTION 'Independent approved document required' USING ERRCODE='42501';END IF;
IF EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (d.document_type,d.supply_kind,CASE WHEN d.supply_kind='receipt' THEN 'goods_receipt' ELSE 'inventory_adjustment' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
tab:=inventory_security.supply_source(d.supply_kind);EXECUTE format('SELECT id FROM inventory.%I WHERE tenant_id=$1 AND business_document_id=$2',tab) INTO source USING t,d.id;
IF d.supply_kind='receipt' THEN
 SELECT p.* INTO ord FROM inventory.procurements p JOIN inventory.goods_receipts r ON r.tenant_id=p.tenant_id AND r.procurement_id=p.id WHERE r.tenant_id=t AND r.id=source FOR UPDATE OF p;
 IF ord.status<>'approved' THEN RAISE EXCEPTION 'Order not open for receiving' USING ERRCODE='23514';END IF;
 IF (SELECT coalesce(sum(r.accepted_quantity),0) FROM inventory.goods_receipt_items r JOIN inventory.procurement_items i ON i.tenant_id=r.tenant_id AND i.id=r.procurement_item_id WHERE r.tenant_id=t AND r.receipt_id=source AND i.destination_kind='asset')>100 THEN RAISE EXCEPTION 'At most 100 individual assets per receipt' USING ERRCODE='23514';END IF;
 -- Every receipt of an order is serialized by the parent order, including asset creation.
 FOR l IN SELECT r.* FROM inventory.goods_receipt_items r JOIN inventory.procurement_items p ON p.tenant_id=r.tenant_id AND p.id=r.procurement_item_id WHERE r.tenant_id=t AND r.receipt_id=source ORDER BY p.inventory_item_id NULLS LAST,r.room_id,r.procurement_item_id LOOP
 SELECT * INTO oi FROM inventory.procurement_items WHERE tenant_id=t AND id=l.procurement_item_id FOR UPDATE;
 IF l.accepted_quantity>oi.quantity-oi.received_quantity OR l.quantity>oi.quantity-oi.received_quantity THEN RAISE EXCEPTION 'Over receipt' USING ERRCODE='23514';END IF;
 IF l.accepted_quantity>0 THEN
  IF oi.destination_kind='inventory' THEN
   line_value:=round((oi.received_quantity+l.accepted_quantity)*oi.unit_cost,2)-round(oi.received_quantity*oi.unit_cost,2);
   PERFORM inventory_security.supply_stock(oi.inventory_item_id,l.room_id,l.accepted_quantity,oi.unit_cost,'receipt',d.id,'receipt:'||l.id,NULL,line_value);
  ELSE
   PERFORM inventory_security.assert_supply_actor('assets.create');
   template:=oi.asset_template||jsonb_build_object('funding_source_id',coalesce((oi.asset_template->>'funding_source_id')::uuid,ord.funding_source_id),'room_id',l.room_id,'acquisition_date',d.business_date::text,'acquisition_cost',oi.unit_cost::text,'lifecycle_status','draft','serial_number','','reason','Penerimaan '||d.document_number,'specifications',jsonb_build_object('description',oi.asset_template->>'specifications'));
   created:=inventory_security.save_asset(NULL,NULL,template,l.accepted_quantity::integer,l.id);
   FOR asset_id IN SELECT value::uuid FROM jsonb_array_elements_text(created->'ids') LOOP INSERT INTO inventory.receipt_asset_links(tenant_id,receipt_item_id,asset_id) VALUES(t,l.id,asset_id);END LOOP;
  END IF;
 END IF;
 UPDATE inventory.procurement_items SET received_quantity=received_quantity+l.accepted_quantity WHERE id=oi.id;
 END LOOP;
 IF NOT EXISTS(SELECT FROM inventory.procurement_items WHERE tenant_id=t AND procurement_id=ord.id AND received_quantity<quantity) THEN UPDATE inventory.procurements SET status='posted' WHERE id=ord.id;UPDATE inventory.business_documents SET status='posted',posted_at=clock_timestamp() WHERE id=ord.business_document_id;END IF;
ELSE
 FOR l IN SELECT * FROM inventory.inventory_transaction_lines WHERE tenant_id=t AND adjustment_id=source ORDER BY item_id,room_id LOOP
 PERFORM inventory_security.supply_stock(l.item_id,l.room_id,l.quantity_delta,l.unit_cost,CASE d.supply_kind WHEN 'receipt_stock' THEN 'receipt' WHEN 'issue' THEN 'issue' ELSE 'adjustment' END,d.id,'stock:'||l.id,l.id);
 END LOOP;
END IF;
EXECUTE format('UPDATE inventory.%I SET status=''posted'' WHERE tenant_id=$1 AND id=$2',tab) USING t,source;
UPDATE inventory.business_documents SET status='posted',posted_at=clock_timestamp(),posting_key=p_key::text WHERE id=d.id;
INSERT INTO inventory.supply_review_events(tenant_id,document_id,actor_id,action,reason,revision) VALUES(t,d.id,actor,'post','Posting atomik dengan nilai rata-rata tertimbang',d.revision);
RETURN jsonb_build_object('posted',true,'reused',false);END $$;
CREATE FUNCTION inventory_security.supply_link_file(p_doc uuid,p_file uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;result uuid;BEGIN
 SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc AND supply_kind IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 PERFORM inventory_security.assert_supply_actor(inventory_security.supply_permission(d.supply_kind));PERFORM inventory_security.assert_supply_actor('files.upload');
 IF NOT EXISTS(SELECT FROM inventory.file_attachments WHERE tenant_id=t AND id=p_file AND status='ready') THEN RAISE EXCEPTION 'Ready tenant file required' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.document_attachments(tenant_id,document_id,file_id) VALUES(t,p_doc,p_file) ON CONFLICT(tenant_id,document_id,file_id) DO UPDATE SET file_id=excluded.file_id RETURNING id INTO result;RETURN result;END $$;
-- Runtime cannot fabricate documents, line totals, received quantities, decisions or balances.
REVOKE INSERT,UPDATE ON inventory.inventory_items,inventory.suppliers,inventory.inventory_adjustments,inventory.procurement_requests,inventory.procurement_request_items,inventory.procurements,inventory.procurement_items,inventory.goods_receipts,inventory.goods_receipt_items,inventory.document_attachments FROM inventory_runtime;
CREATE FUNCTION inventory_security.protect_inventory_category() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,inventory AS $$ BEGIN
IF NEW.asset_kind<>'inventory' AND OLD.asset_kind='inventory' AND EXISTS(SELECT FROM inventory.inventory_items WHERE tenant_id=OLD.tenant_id AND category_id=OLD.id) THEN RAISE EXCEPTION 'Used inventory category immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER protect_inventory_category BEFORE UPDATE ON inventory.asset_categories FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_inventory_category();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.supply_policy(text,text),inventory_security.supply_master(text,uuid,bigint,jsonb),inventory_security.supply_save(uuid,bigint,uuid,jsonb),inventory_security.supply_transition(uuid,bigint,text,text),inventory_security.supply_post(uuid,uuid),inventory_security.supply_link_file(uuid,uuid) TO inventory_runtime;
COMMIT;
