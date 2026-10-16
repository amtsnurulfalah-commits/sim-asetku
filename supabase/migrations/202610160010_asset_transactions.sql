BEGIN;
ALTER TABLE inventory.maintenance_requests ADD COLUMN business_document_id uuid;
ALTER TABLE inventory.maintenance_requests ADD FOREIGN KEY(tenant_id,business_document_id) REFERENCES inventory.business_documents(tenant_id,id);
CREATE UNIQUE INDEX ON inventory.maintenance_requests(tenant_id,business_document_id,asset_id);
ALTER TABLE inventory.maintenance_schedules ADD COLUMN fulfilled_at timestamptz;
ALTER TABLE inventory.maintenance_costs ADD COLUMN capitalization_status text CHECK(capitalization_status IN ('not_applicable','pending_policy'));
ALTER TABLE inventory.asset_returns ADD COLUMN business_document_id uuid;
ALTER TABLE inventory.asset_returns ADD FOREIGN KEY(tenant_id,business_document_id) REFERENCES inventory.business_documents(tenant_id,id);
CREATE UNIQUE INDEX ON inventory.asset_returns(tenant_id,business_document_id);
ALTER TABLE inventory.tenant_settings ADD COLUMN asset_review_mode text NOT NULL DEFAULT 'disabled' CHECK(asset_review_mode IN ('disabled','single_admin_v1'));
CREATE TABLE inventory.asset_transactions (
 id uuid PRIMARY KEY REFERENCES inventory.business_documents(id),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),
 kind text NOT NULL CHECK(kind IN ('placement','movement','loan','return','maintenance','maintenance_finish','opname','disposal')),
 parent_id uuid, payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES inventory.business_documents(tenant_id,id),FOREIGN KEY(tenant_id,parent_id) REFERENCES inventory.asset_transactions(tenant_id,id)
);
CREATE TABLE inventory.asset_transaction_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),transaction_id uuid NOT NULL,asset_id uuid NOT NULL,
 snapshot jsonb NOT NULL,observation jsonb,checked_by uuid,checked_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,transaction_id,asset_id),FOREIGN KEY(tenant_id,transaction_id) REFERENCES inventory.asset_transactions(tenant_id,id),
 FOREIGN KEY(tenant_id,asset_id) REFERENCES inventory.assets(tenant_id,id),FOREIGN KEY(tenant_id,checked_by) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
CREATE TABLE inventory.asset_transaction_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),transaction_id uuid,actor_id uuid NOT NULL,
 action text NOT NULL,reason text NOT NULL,revision integer,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,transaction_id) REFERENCES inventory.asset_transactions(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['asset_transactions','asset_transaction_lines','asset_transaction_events'] LOOP
 EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY migration_owner ON inventory.%I TO %I USING(true) WITH CHECK(true)',tab,current_user);
 EXECUTE format('CREATE POLICY tenant_scope ON inventory.%I TO inventory_runtime USING(tenant_id=inventory_security.tenant_id())',tab);
 EXECUTE format('GRANT SELECT ON inventory.%I TO inventory_runtime',tab);
 EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.audit_change()',tab);
 EXECUTE format('CREATE INDEX ON inventory.%I(tenant_id,created_at,id)',tab);
 END LOOP;
END $$;
CREATE INDEX ON inventory.asset_transaction_lines(tenant_id,asset_id,transaction_id);
CREATE INDEX ON inventory.asset_transaction_events(tenant_id,transaction_id,created_at);
CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.asset_transaction_events FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite();
REVOKE INSERT,UPDATE,DELETE ON inventory.asset_movements,inventory.asset_movement_items,inventory.asset_loans,inventory.asset_loan_items,inventory.asset_returns,inventory.asset_return_items,inventory.asset_reservations,inventory.maintenance_requests,inventory.maintenance_schedules,inventory.maintenance_records,inventory.maintenance_costs,inventory.stock_opname_sessions,inventory.stock_opname_assignments,inventory.stock_opname_items,inventory.stock_opname_findings,inventory.stock_opname_adjustments,inventory.disposal_requests,inventory.disposal_request_items,inventory.asset_disposals FROM inventory_runtime;
CREATE FUNCTION inventory_security.assert_transaction_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission IN ('settings.manage','approval.manage') THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('assets.view','movements.create','movements.approve','loans.create','loans.approve','maintenance.manage','stockopname.execute','stockopname.approve','disposal.create','disposal.approve','files.upload','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
PERFORM 1 FROM inventory.tenants WHERE id=t AND status='active' FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Active tenant required' USING ERRCODE='42501'; END IF;
SELECT * INTO s FROM inventory.app_sessions WHERE app_user_id=u AND token_digest=nullif(current_setting('app.session_digest',true),'');
IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.idle_expires_at<=clock_timestamp() OR s.active_tenant_id IS DISTINCT FROM t OR s.active_membership_id IS DISTINCT FROM nullif(current_setting('app.membership_id',true),'')::uuid THEN RAISE EXCEPTION 'Session denied' USING ERRCODE='42501'; END IF;
SELECT * INTO m FROM inventory.tenant_memberships WHERE tenant_id=t AND id=s.active_membership_id AND app_user_id=u AND status='active';
IF NOT FOUND OR m.authorization_version<>s.authorization_version OR NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active')
OR NOT EXISTS(SELECT FROM inventory.sso_status_cache WHERE app_user_id=u AND can_authenticate AND identity_version=s.identity_version AND valid_until>clock_timestamp())
OR NOT(EXISTS(SELECT FROM inventory.role_permissions WHERE tenant_id=t AND role_id=m.role_id AND permission_code=p_permission)
OR EXISTS(SELECT FROM inventory.membership_permission_grants WHERE tenant_id=t AND membership_id=m.id AND permission_code=p_permission AND (expires_at IS NULL OR expires_at>clock_timestamp()))) THEN RAISE EXCEPTION 'Asset actor denied' USING ERRCODE='42501'; END IF;
RETURN m.id; END $$;
REVOKE ALL ON FUNCTION inventory_security.assert_transaction_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_transaction_actor(text) TO inventory_runtime;
CREATE FUNCTION inventory_security.transaction_permission(k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE WHEN k IN ('placement','movement') THEN 'movements.create' WHEN k IN ('loan','return') THEN 'loans.create' WHEN k IN ('maintenance','maintenance_finish') THEN 'maintenance.manage' WHEN k='opname' THEN 'stockopname.execute' WHEN k='disposal' THEN 'disposal.create' END $$;
CREATE FUNCTION inventory_security.transaction_policy(p_mode text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$ DECLARE actor uuid;BEGIN
actor:=inventory_security.assert_tenant_admin();IF p_mode IS NULL OR p_mode NOT IN ('disabled','single_admin_v1') OR p_reason IS NULL OR length(btrim(p_reason))<3 THEN RAISE EXCEPTION 'Invalid policy' USING ERRCODE='23514';END IF;
UPDATE inventory.tenant_settings SET asset_review_mode=p_mode WHERE tenant_id=inventory_security.tenant_id();
INSERT INTO inventory.asset_transaction_events(tenant_id,actor_id,action,reason) VALUES(inventory_security.tenant_id(),actor,'policy:'||p_mode,p_reason);END $$;
CREATE FUNCTION inventory_security.transaction_save(p_id uuid,p_version bigint,p_key uuid,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;k text:=p_data->>'kind';d inventory.business_documents;prior inventory.idempotency_records;digest text;bid uuid;num text;a inventory.assets;l jsonb;pid uuid:=(p_data->>'parentId')::uuid;ids uuid[]:='{}';assignee uuid;datevalue date:=(p_data->>'date')::date;
BEGIN
actor:=inventory_security.assert_transaction_actor(inventory_security.transaction_permission(k));
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
IF k IS NULL OR inventory_security.transaction_permission(k) IS NULL OR p_key IS NULL OR p_data->>'reason' IS NULL OR length(btrim(p_data->>'reason')) NOT BETWEEN 3 AND 2000 OR datevalue IS NULL OR datevalue>(SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM inventory.tenants WHERE id=t) THEN RAISE EXCEPTION 'Invalid transaction' USING ERRCODE='23514';END IF;
digest:=encode(sha256(convert_to(p_data::text||actor::text||coalesce(p_id::text,'new')||coalesce(p_version::text,'new'),'UTF8')),'hex');
SELECT * INTO prior FROM inventory.idempotency_records WHERE tenant_id=t AND operation='transaction.save' AND idempotency_key=p_key::text;
IF FOUND THEN IF prior.request_digest<>digest THEN RAISE EXCEPTION 'Idempotency mismatch' USING ERRCODE='23514';END IF;RETURN prior.resource_id;END IF;
IF p_id IS NOT NULL THEN
 SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id AND kind=k) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF d.row_version<>p_version THEN RAISE EXCEPTION 'Stale version' USING ERRCODE='40001';END IF;
 IF d.requested_by<>actor OR d.status NOT IN ('draft','revision_required') THEN RAISE EXCEPTION 'Owner draft required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=p_id AND checked_at IS NOT NULL) THEN RAISE EXCEPTION 'Observed opname scope immutable' USING ERRCODE='23514';END IF;
 bid:=d.id;DELETE FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=bid;
 UPDATE inventory.business_documents SET input_snapshot=p_data,business_date=datevalue,supply_reason=p_data->>'reason',status='draft',revision=revision+1,source_revision=source_revision+1,review_mode_snapshot=NULL WHERE id=bid;
 UPDATE inventory.asset_transactions SET parent_id=pid,payload=p_data WHERE id=bid;
ELSE
 num:='AST-'||upper(k)||'/'||inventory_security.next_number('asset-transaction:'||k,0)::text;
 INSERT INTO inventory.business_documents(tenant_id,document_number,business_date,requested_by,document_type,input_snapshot,supply_reason) VALUES(t,num,datevalue,actor,'asset:'||k,p_data,p_data->>'reason') RETURNING id INTO bid;
 INSERT INTO inventory.asset_transactions(id,tenant_id,kind,parent_id,payload) VALUES(bid,t,k,pid,p_data);
END IF;
IF k IN ('return','maintenance_finish') THEN
 IF NOT EXISTS(SELECT FROM inventory.asset_transactions x JOIN inventory.business_documents b ON b.id=x.id AND b.tenant_id=x.tenant_id WHERE x.tenant_id=t AND x.id=pid AND x.kind=CASE k WHEN 'return' THEN 'loan' ELSE 'maintenance' END AND b.status='posted' AND b.business_date<=datevalue) THEN RAISE EXCEPTION 'Posted parent required' USING ERRCODE='23514';END IF;
ELSIF pid IS NOT NULL THEN RAISE EXCEPTION 'Unexpected parent' USING ERRCODE='23514';END IF;
IF k IN ('placement','movement','return','maintenance_finish') AND NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(p_data->>'roomId')::uuid AND status='active') THEN RAISE EXCEPTION 'Active room required' USING ERRCODE='23514';END IF;
IF p_data->>'responsibleId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=t AND id=(p_data->>'responsibleId')::uuid AND status='active') THEN RAISE EXCEPTION 'Active responsible required' USING ERRCODE='23514';END IF;
IF k IN ('return','maintenance_finish') AND NOT EXISTS(SELECT FROM inventory.asset_conditions WHERE tenant_id=t AND id=(p_data->>'conditionId')::uuid AND status='active') THEN RAISE EXCEPTION 'Condition required' USING ERRCODE='23514';END IF;
IF k='loan' AND (length(btrim(p_data->>'borrower'))<3 OR (p_data->>'dueAt')::timestamptz<=(p_data->>'startAt')::timestamptz OR p_data->>'dueAt' IS NULL OR p_data->>'startAt' IS NULL) THEN RAISE EXCEPTION 'Loan dates/borrower required' USING ERRCODE='23514';END IF;
IF k='maintenance' THEN
 IF p_data->>'maintenanceType' NOT IN ('preventive','corrective') OR p_data->>'startAt' IS NULL OR (p_data->>'nextDueAt')::timestamptz<=(p_data->>'startAt')::timestamptz THEN RAISE EXCEPTION 'Maintenance dates/type required' USING ERRCODE='23514';END IF;
 assignee:=(p_data->>'assigneeId')::uuid;
 IF NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=t AND id=assignee AND status='active') THEN RAISE EXCEPTION 'Active assignee required' USING ERRCODE='23514';END IF;
 IF p_data->>'supplierId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.suppliers WHERE tenant_id=t AND id=(p_data->>'supplierId')::uuid AND status='active') THEN RAISE EXCEPTION 'Active vendor required' USING ERRCODE='23514';END IF;
END IF;
IF k='maintenance_finish' AND coalesce(p_data->>'costTreatment','expense') NOT IN ('expense','capitalization_review') THEN RAISE EXCEPTION 'Invalid cost treatment' USING ERRCODE='23514';END IF;
IF k='maintenance_finish' AND (p_data->>'completedAt' IS NULL OR (p_data->>'completedAt')::timestamptz>clock_timestamp() OR (p_data->>'cost')::numeric<0 OR p_data->>'cost' IS NULL OR (p_data->>'completedAt')::timestamptz<(SELECT (payload->>'startAt')::timestamptz FROM inventory.asset_transactions WHERE id=pid)) THEN RAISE EXCEPTION 'Invalid completion/cost' USING ERRCODE='23514';END IF;
IF k='opname' THEN
 IF NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=t AND id=(p_data->>'assigneeId')::uuid AND status='active') THEN RAISE EXCEPTION 'Active examiner required' USING ERRCODE='23514';END IF;
 IF p_data->>'scopeRoomId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(p_data->>'scopeRoomId')::uuid AND status='active') OR p_data->>'scopeCategoryId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.asset_categories WHERE tenant_id=t AND id=(p_data->>'scopeCategoryId')::uuid AND status='active') THEN RAISE EXCEPTION 'Invalid scope' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.asset_transaction_lines(tenant_id,transaction_id,asset_id,snapshot)
 SELECT t,bid,id,jsonb_build_object('code',inventory_code,'name',name,'roomId',room_id,'conditionId',condition_id,'responsibleId',responsible_membership_id,'lifecycle',lifecycle_status,'version',row_version) FROM inventory.assets WHERE tenant_id=t AND lifecycle_status NOT IN ('disposed','archived','draft') AND (p_data->>'scopeRoomId' IS NULL OR room_id=(p_data->>'scopeRoomId')::uuid) AND (p_data->>'scopeCategoryId' IS NULL OR category_id=(p_data->>'scopeCategoryId')::uuid);
 IF (SELECT count(*) FROM inventory.asset_transaction_lines WHERE transaction_id=bid) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Opname scope must contain 1..2000 assets' USING ERRCODE='23514';END IF;
ELSE
 IF jsonb_typeof(p_data->'assets') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'assets') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Select 1..50 assets' USING ERRCODE='23514';END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(p_data->'assets') LOOP
 SELECT * INTO a FROM inventory.assets WHERE tenant_id=t AND id=(l#>>'{}')::uuid FOR UPDATE;
 IF NOT FOUND OR a.id=ANY(ids) THEN RAISE EXCEPTION 'Unknown or duplicate asset' USING ERRCODE='23514';END IF;ids:=array_append(ids,a.id);
 IF k IN ('placement','movement','loan','maintenance','disposal') AND a.lifecycle_status<>'available' OR k='placement' AND a.room_id IS NOT NULL THEN RAISE EXCEPTION 'Asset unavailable or already placed' USING ERRCODE='23514';END IF;
 IF k='loan' AND NOT EXISTS(SELECT FROM inventory.asset_conditions WHERE tenant_id=t AND id=a.condition_id AND loan_allowed AND status='active') THEN RAISE EXCEPTION 'Asset not loanable' USING ERRCODE='23514';END IF;
 IF k IN ('return','maintenance_finish') AND NOT EXISTS(SELECT FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=pid AND asset_id=a.id) THEN RAISE EXCEPTION 'Asset not in parent' USING ERRCODE='23514';END IF;
 IF k='return' AND a.lifecycle_status<>'on_loan' OR k='maintenance_finish' AND a.lifecycle_status<>'maintenance' THEN RAISE EXCEPTION 'Asset not outstanding' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.asset_transaction_lines(tenant_id,transaction_id,asset_id,snapshot) VALUES(t,bid,a.id,jsonb_build_object('code',a.inventory_code,'name',a.name,'roomId',a.room_id,'conditionId',a.condition_id,'responsibleId',a.responsible_membership_id,'lifecycle',a.lifecycle_status,'version',a.row_version));
 END LOOP;
END IF;
INSERT INTO inventory.asset_transaction_events(tenant_id,transaction_id,actor_id,action,reason,revision,details) SELECT t,bid,actor,'save',p_data->>'reason',revision,jsonb_build_object('digest',digest) FROM inventory.business_documents WHERE id=bid;
INSERT INTO inventory.idempotency_records(tenant_id,operation,idempotency_key,request_digest,resource_id,expires_at) VALUES(t,'transaction.save',p_key::text,digest,bid,clock_timestamp()+interval '10 years');RETURN bid;
END $$;
CREATE FUNCTION inventory_security.transaction_observe(p_id uuid,p_version bigint,p_asset uuid,p_observation jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;x inventory.asset_transactions;d inventory.business_documents;l inventory.asset_transaction_lines;finding text;BEGIN
actor:=inventory_security.assert_transaction_actor('stockopname.execute');PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id AND kind='opname';
IF x.id IS NULL OR d.status NOT IN ('draft','revision_required') OR (x.payload->>'assigneeId')::uuid<>actor THEN RAISE EXCEPTION 'Assigned examiner draft required' USING ERRCODE='42501';END IF;
IF d.row_version<>p_version THEN RAISE EXCEPTION 'Stale version' USING ERRCODE='40001';END IF;
IF p_observation->>'notes' IS NULL OR length(btrim(p_observation->>'notes')) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Inspection notes required' USING ERRCODE='23514';END IF;
IF p_asset IS NULL THEN
 IF (SELECT count(*) FROM inventory.asset_transaction_events WHERE tenant_id=t AND transaction_id=p_id AND action='unregistered')>=2000 THEN RAISE EXCEPTION 'Maximum 2000 unregistered findings per period' USING ERRCODE='23514';END IF;
 IF p_observation->>'finding'<>'unregistered' THEN RAISE EXCEPTION 'Unregistered finding required' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.asset_transaction_events(tenant_id,transaction_id,actor_id,action,reason,revision,details) VALUES(t,p_id,actor,'unregistered',p_observation->>'notes',d.revision,p_observation);
ELSE
 SELECT * INTO l FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=p_id AND asset_id=p_asset FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Asset outside opname snapshot' USING ERRCODE='23514';END IF;
 IF p_observation->>'finding' IN ('not_found','follow_up') THEN finding:=p_observation->>'finding';
 ELSE
 IF NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(p_observation->>'roomId')::uuid AND status='active') OR NOT EXISTS(SELECT FROM inventory.asset_conditions WHERE tenant_id=t AND id=(p_observation->>'conditionId')::uuid AND status='active') THEN RAISE EXCEPTION 'Observed room and condition required' USING ERRCODE='23514';END IF;
 finding:=CASE WHEN l.snapshot->>'roomId' IS DISTINCT FROM p_observation->>'roomId' THEN 'location_changed' WHEN l.snapshot->>'conditionId' IS DISTINCT FROM p_observation->>'conditionId' THEN 'condition_changed' ELSE 'matched' END;
 END IF;
 UPDATE inventory.asset_transaction_lines SET observation=p_observation||jsonb_build_object('finding',finding),checked_by=actor,checked_at=clock_timestamp() WHERE id=l.id;
 INSERT INTO inventory.asset_transaction_events(tenant_id,transaction_id,actor_id,action,reason,revision,details) VALUES(t,p_id,actor,'observe',p_observation->>'notes',d.revision,jsonb_build_object('assetId',p_asset,'observation',p_observation,'finding',finding));
END IF;
UPDATE inventory.business_documents SET source_revision=source_revision+1 WHERE id=p_id;
END $$;
CREATE FUNCTION inventory_security.transaction_transition(p_id uuid,p_version bigint,p_action text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;x inventory.asset_transactions;actor uuid;state text;mode text;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id;SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;
IF x.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_transaction_actor(CASE WHEN p_action IN ('review','approve','reject','revision') THEN 'approval.manage' ELSE inventory_security.transaction_permission(x.kind) END);
IF d.row_version<>p_version THEN RAISE EXCEPTION 'Stale version' USING ERRCODE='40001';END IF;
IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514';END IF;
SELECT asset_review_mode INTO mode FROM inventory.tenant_settings WHERE tenant_id=t;
IF p_action IN ('submit','review','approve') AND EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (x.kind,d.document_type,CASE x.kind WHEN 'placement' THEN 'asset_movement' WHEN 'movement' THEN 'asset_movement' WHEN 'loan' THEN 'asset_loan' WHEN 'return' THEN 'asset_return' WHEN 'maintenance' THEN 'maintenance_request' WHEN 'maintenance_finish' THEN 'maintenance_request' WHEN 'opname' THEN 'stock_opname' WHEN 'disposal' THEN 'disposal_request' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
IF p_action='submit' THEN
 IF x.kind='disposal' AND NOT EXISTS(SELECT FROM inventory.document_attachments att JOIN inventory.file_attachments f ON f.tenant_id=att.tenant_id AND f.id=att.file_id WHERE att.tenant_id=t AND att.document_id=p_id AND f.status='ready') THEN RAISE EXCEPTION 'Disposal evidence required' USING ERRCODE='23514';END IF;
 IF d.status NOT IN ('draft','revision_required') OR d.requested_by<>actor OR mode<>'single_admin_v1' THEN RAISE EXCEPTION 'Explicit review policy and owner draft required' USING ERRCODE='42501';END IF;
 IF x.kind='opname' AND EXISTS(SELECT FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=p_id AND checked_at IS NULL) THEN RAISE EXCEPTION 'Complete all inspections first' USING ERRCODE='23514';END IF;
 state:='submitted';
ELSIF p_action IN ('review','approve','reject','revision') THEN
 IF d.requested_by=actor OR d.review_mode_snapshot IS DISTINCT FROM 'single_admin_v1' THEN RAISE EXCEPTION 'Independent reviewer required' USING ERRCODE='42501';END IF;
 IF x.kind='opname' AND (x.payload->>'assigneeId')::uuid=actor THEN RAISE EXCEPTION 'Examiner cannot approve own checks' USING ERRCODE='42501';END IF;
 IF p_action='revision' AND d.status='approved' THEN state:='revision_required';ELSIF p_action='review' AND d.status='submitted' THEN state:='pending';ELSIF d.status='pending' THEN state:=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'revision' THEN 'revision_required' END;END IF;
ELSIF p_action='cancel' AND d.status IN ('draft','submitted','pending','revision_required','rejected') AND d.requested_by=actor THEN state:='cancelled';END IF;
IF state IS NULL THEN RAISE EXCEPTION 'Invalid transition' USING ERRCODE='23514';END IF;
UPDATE inventory.business_documents SET status=state,review_mode_snapshot=CASE WHEN p_action='submit' THEN mode ELSE review_mode_snapshot END WHERE id=p_id;
INSERT INTO inventory.asset_transaction_events(tenant_id,transaction_id,actor_id,action,reason,revision,details) VALUES(t,p_id,actor,p_action,p_reason,d.revision,jsonb_build_object('payload',x.payload));END $$;
CREATE FUNCTION inventory_security.transaction_post(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;x inventory.asset_transactions;l inventory.asset_transaction_lines;a inventory.assets;v jsonb;source uuid;li uuid;rec uuid;n int:=0;parent_source uuid;oldcond uuid;oldroom uuid;foundsource uuid;
BEGIN
-- Coarse tenant lock intentionally serializes business transactions; lock order is tenant -> document -> assets sorted UUID.
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id;
IF x.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_transaction_actor(inventory_security.transaction_permission(x.kind));
IF d.status='posted' THEN RETURN jsonb_build_object('id',p_id,'reused',true);END IF;
IF d.status<>'approved' OR d.review_mode_snapshot IS DISTINCT FROM 'single_admin_v1' OR NOT EXISTS(SELECT FROM inventory.asset_transaction_events WHERE tenant_id=t AND transaction_id=p_id AND action='approve' AND revision=d.revision AND actor_id<>d.requested_by) THEN RAISE EXCEPTION 'Independent approved revision required' USING ERRCODE='42501';END IF;
IF EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (x.kind,d.document_type,CASE x.kind WHEN 'placement' THEN 'asset_movement' WHEN 'movement' THEN 'asset_movement' WHEN 'loan' THEN 'asset_loan' WHEN 'return' THEN 'asset_return' WHEN 'maintenance' THEN 'maintenance_request' WHEN 'maintenance_finish' THEN 'maintenance_request' WHEN 'opname' THEN 'stock_opname' WHEN 'disposal' THEN 'disposal_request' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
v:=x.payload;
IF x.kind='disposal' AND NOT EXISTS(SELECT FROM inventory.document_attachments att JOIN inventory.file_attachments f ON f.tenant_id=att.tenant_id AND f.id=att.file_id WHERE att.tenant_id=t AND att.document_id=p_id AND f.status='ready') THEN RAISE EXCEPTION 'Disposal evidence required' USING ERRCODE='23514';END IF;
IF x.kind IN ('placement','movement','return','maintenance_finish') AND NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(v->>'roomId')::uuid AND status='active') OR v->>'responsibleId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=t AND id=(v->>'responsibleId')::uuid AND status='active') THEN RAISE EXCEPTION 'Inactive target' USING ERRCODE='23514';END IF;
IF x.kind IN ('return','maintenance_finish') AND NOT EXISTS(SELECT FROM inventory.asset_conditions WHERE tenant_id=t AND id=(v->>'conditionId')::uuid AND status='active') THEN RAISE EXCEPTION 'Inactive condition' USING ERRCODE='23514';END IF;
IF x.kind IN ('placement','movement') THEN
 INSERT INTO inventory.asset_movements(tenant_id,document_number,status,business_date,requested_by,reason,business_document_id) VALUES(t,d.document_number,'posted',d.business_date,d.requested_by,d.supply_reason,d.id) RETURNING id INTO source;
ELSIF x.kind='loan' THEN
 INSERT INTO inventory.asset_loans(tenant_id,document_number,status,business_date,requested_by,borrower_name,purpose,planned_checkout_at,due_at,business_document_id) VALUES(t,d.document_number,'posted',d.business_date,d.requested_by,v->>'borrower',d.supply_reason,(v->>'startAt')::timestamptz,(v->>'dueAt')::timestamptz,d.id) RETURNING id INTO source;
ELSIF x.kind='return' THEN
 SELECT id INTO parent_source FROM inventory.asset_loans WHERE tenant_id=t AND business_document_id=x.parent_id;
 INSERT INTO inventory.asset_returns(tenant_id,document_number,status,business_date,requested_by,loan_id,returned_at,business_document_id) VALUES(t,d.document_number,'posted',d.business_date,d.requested_by,parent_source,clock_timestamp(),d.id) RETURNING id INTO source;
ELSIF x.kind='disposal' THEN
 INSERT INTO inventory.disposal_requests(tenant_id,document_number,status,business_date,requested_by,reason,business_document_id) VALUES(t,d.document_number,'posted',d.business_date,d.requested_by,d.supply_reason,d.id) RETURNING id INTO source;
ELSIF x.kind='opname' THEN
 INSERT INTO inventory.stock_opname_sessions(tenant_id,document_number,status,business_date,requested_by,scope_snapshot,opened_at,closed_at,business_document_id) VALUES(t,d.document_number,'posted',d.business_date,d.requested_by,v,x.created_at,clock_timestamp(),d.id) RETURNING id INTO source;
 INSERT INTO inventory.stock_opname_assignments(tenant_id,session_id,membership_id) VALUES(t,source,(v->>'assigneeId')::uuid);
END IF;
FOR l IN SELECT * FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=p_id ORDER BY asset_id LOOP
 SELECT * INTO a FROM inventory.assets WHERE tenant_id=t AND id=l.asset_id FOR UPDATE;
 oldcond:=a.condition_id;oldroom:=a.room_id;n:=n+1;
 IF x.kind<>'opname' AND a.row_version<>(l.snapshot->>'version')::bigint THEN RAISE EXCEPTION 'Asset snapshot stale; request revision' USING ERRCODE='40001';END IF;
 IF x.kind IN ('placement','movement','loan','maintenance','disposal') AND a.lifecycle_status<>'available' THEN RAISE EXCEPTION 'Asset unavailable' USING ERRCODE='23514';END IF;
 IF x.kind IN ('placement','movement') THEN
 INSERT INTO inventory.asset_movement_items(tenant_id,movement_id,line_number,asset_id,from_room_id,to_room_id,from_responsible_id,to_responsible_id) VALUES(t,source,n,a.id,a.room_id,(v->>'roomId')::uuid,a.responsible_membership_id,(v->>'responsibleId')::uuid);
 UPDATE inventory.assets SET room_id=(v->>'roomId')::uuid,responsible_membership_id=(v->>'responsibleId')::uuid WHERE id=a.id;
ELSIF x.kind='loan' THEN
 IF (v->>'startAt')::timestamptz>clock_timestamp() OR (v->>'dueAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'Loan due date already passed' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.asset_loan_items(tenant_id,loan_id,line_number,asset_id) VALUES(t,source,n,a.id) RETURNING id INTO li;
 INSERT INTO inventory.asset_reservations(tenant_id,asset_id,loan_item_id,reserved_by) VALUES(t,a.id,li,actor);
 UPDATE inventory.assets SET lifecycle_status='on_loan' WHERE id=a.id;
ELSIF x.kind='return' THEN
 SELECT i.id INTO li FROM inventory.asset_loan_items i JOIN inventory.asset_reservations r ON r.tenant_id=i.tenant_id AND r.loan_item_id=i.id WHERE i.tenant_id=t AND i.loan_id=parent_source AND i.asset_id=a.id AND r.released_at IS NULL;
 IF li IS NULL OR a.lifecycle_status<>'on_loan' THEN RAISE EXCEPTION 'Asset no longer outstanding on parent loan' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.asset_return_items(tenant_id,return_id,line_number,loan_item_id,condition_id,room_id,notes,loan_id) VALUES(t,source,n,li,(v->>'conditionId')::uuid,(v->>'roomId')::uuid,d.supply_reason,parent_source);
 UPDATE inventory.asset_reservations SET released_at=clock_timestamp() WHERE tenant_id=t AND loan_item_id=li AND released_at IS NULL;
 UPDATE inventory.assets SET lifecycle_status='available',room_id=(v->>'roomId')::uuid,condition_id=(v->>'conditionId')::uuid WHERE id=a.id;
ELSIF x.kind='maintenance' THEN
 IF (v->>'startAt')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'Maintenance start in future' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=t AND id=(v->>'assigneeId')::uuid AND status='active') OR v->>'supplierId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.suppliers WHERE tenant_id=t AND id=(v->>'supplierId')::uuid AND status='active') THEN RAISE EXCEPTION 'Inactive technician/vendor' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.maintenance_requests(tenant_id,document_number,status,business_date,requested_by,asset_id,description,maintenance_type,business_document_id) VALUES(t,d.document_number||'/'||n,'posted',d.business_date,d.requested_by,a.id,d.supply_reason,v->>'maintenanceType',d.id) RETURNING id INTO rec;
 INSERT INTO inventory.maintenance_records(tenant_id,request_id,started_at,supplier_id,assigned_to,notes) VALUES(t,rec,(v->>'startAt')::timestamptz,(v->>'supplierId')::uuid,(v->>'assigneeId')::uuid,d.supply_reason);
 UPDATE inventory.maintenance_schedules SET fulfilled_at=clock_timestamp() WHERE tenant_id=t AND asset_id=a.id AND fulfilled_at IS NULL AND next_due_at<=(v->>'startAt')::timestamptz;
 IF v->>'nextDueAt' IS NOT NULL THEN INSERT INTO inventory.maintenance_schedules(tenant_id,asset_id,next_due_at,assigned_to) VALUES(t,a.id,(v->>'nextDueAt')::timestamptz,(v->>'assigneeId')::uuid);END IF;
 UPDATE inventory.assets SET lifecycle_status='maintenance' WHERE id=a.id;
ELSIF x.kind='maintenance_finish' THEN
 SELECT r.id INTO rec FROM inventory.maintenance_records r JOIN inventory.maintenance_requests m ON m.tenant_id=r.tenant_id AND m.id=r.request_id WHERE r.tenant_id=t AND m.asset_id=a.id AND m.business_document_id=x.parent_id AND r.completed_at IS NULL FOR UPDATE OF r;
 IF rec IS NULL OR a.lifecycle_status<>'maintenance' THEN RAISE EXCEPTION 'Maintenance no longer open' USING ERRCODE='23514';END IF;
 UPDATE inventory.maintenance_records SET completed_at=(v->>'completedAt')::timestamptz WHERE id=rec;
 -- Capitalization is deliberately not posted here; it needs accounting policy in later stages.
 INSERT INTO inventory.maintenance_costs(tenant_id,record_id,amount,treatment,description,capitalization_status) VALUES(t,rec,(v->>'cost')::numeric,CASE WHEN v->>'costTreatment'='capitalization_review' THEN 'capitalization' ELSE 'expense' END,d.supply_reason,CASE WHEN v->>'costTreatment'='capitalization_review' THEN 'pending_policy' ELSE 'not_applicable' END);
 UPDATE inventory.assets SET lifecycle_status='available',condition_id=(v->>'conditionId')::uuid,room_id=(v->>'roomId')::uuid WHERE id=a.id;
ELSIF x.kind='disposal' THEN
 INSERT INTO inventory.disposal_request_items(tenant_id,request_id,line_number,asset_id,reason) VALUES(t,source,n,a.id,d.supply_reason) RETURNING id INTO li;
 INSERT INTO inventory.asset_disposals(tenant_id,request_item_id,asset_id,disposed_at,proceeds,posting_key) VALUES(t,li,a.id,clock_timestamp(),0,d.id::text||':'||a.id::text);
 UPDATE inventory.assets SET lifecycle_status='disposed' WHERE id=a.id;
ELSIF x.kind='opname' THEN
 IF l.checked_at IS NULL THEN RAISE EXCEPTION 'Incomplete inspection' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.stock_opname_items(tenant_id,session_id,asset_id,expected_room_id,expected_condition_id,snapshot_version,observed_room_id,observed_condition_id,checked_by,checked_at,finding) VALUES(t,source,a.id,(l.snapshot->>'roomId')::uuid,(l.snapshot->>'conditionId')::uuid,(l.snapshot->>'version')::bigint,(l.observation->>'roomId')::uuid,(l.observation->>'conditionId')::uuid,l.checked_by,l.checked_at,l.observation->>'finding') RETURNING id INTO li;
 IF l.observation->>'finding'<>'matched' THEN INSERT INTO inventory.stock_opname_findings(tenant_id,session_id,opname_item_id,kind,description) VALUES(t,source,li,CASE l.observation->>'finding' WHEN 'not_found' THEN 'missing' WHEN 'condition_changed' THEN 'condition' WHEN 'location_changed' THEN 'location' ELSE 'other' END,l.observation->>'notes');END IF;
END IF;
IF x.kind IN ('placement','movement','return','maintenance_finish') THEN
 IF oldroom IS DISTINCT FROM (v->>'roomId')::uuid THEN INSERT INTO inventory.asset_location_history(tenant_id,asset_id,from_room_id,to_room_id,actor_id,reason) VALUES(t,a.id,oldroom,(v->>'roomId')::uuid,actor,d.document_number||': '||d.supply_reason);END IF;
 IF x.kind IN ('return','maintenance_finish') AND oldcond IS DISTINCT FROM (v->>'conditionId')::uuid THEN INSERT INTO inventory.asset_condition_history(tenant_id,asset_id,from_condition_id,to_condition_id,actor_id,reason) VALUES(t,a.id,oldcond,(v->>'conditionId')::uuid,actor,d.document_number||': '||d.supply_reason);END IF;
END IF;
END LOOP;
IF x.kind='opname' THEN INSERT INTO inventory.stock_opname_findings(tenant_id,session_id,kind,description) SELECT t,source,'unregistered',reason FROM inventory.asset_transaction_events WHERE tenant_id=t AND transaction_id=p_id AND action='unregistered';END IF;
UPDATE inventory.business_documents SET status='posted' WHERE id=p_id;
INSERT INTO inventory.asset_transaction_events(tenant_id,transaction_id,actor_id,action,reason,revision,details) VALUES(t,p_id,actor,'post',d.supply_reason,d.revision,jsonb_build_object('count',n));
RETURN jsonb_build_object('id',p_id,'reused',false,'count',n);
END $$;
CREATE FUNCTION inventory_security.transaction_link(p_id uuid,p_file uuid,p_purpose text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;x inventory.asset_transactions;BEGIN
SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id;
IF x.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_transaction_actor(inventory_security.transaction_permission(x.kind));PERFORM inventory_security.assert_transaction_actor('files.upload');
IF NOT EXISTS(SELECT FROM inventory.file_attachments WHERE tenant_id=t AND id=p_file AND status='ready') OR p_purpose NOT IN ('handover','before','after','evidence','report','decision') THEN RAISE EXCEPTION 'Ready document and purpose required' USING ERRCODE='23514';END IF;
IF EXISTS(SELECT FROM inventory.file_attachments WHERE tenant_id=t AND id=p_file AND sensitivity='sensitive') THEN PERFORM inventory_security.assert_transaction_actor('files.sensitive.download');END IF;
INSERT INTO inventory.document_attachments(tenant_id,document_id,file_id) VALUES(t,p_id,p_file) ON CONFLICT DO NOTHING;
INSERT INTO inventory.asset_transaction_events(tenant_id,transaction_id,actor_id,action,reason,details) VALUES(t,p_id,actor,'attach',p_purpose,jsonb_build_object('fileId',p_file));END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.transaction_policy(text,text),inventory_security.transaction_save(uuid,bigint,uuid,jsonb),inventory_security.transaction_observe(uuid,bigint,uuid,jsonb),inventory_security.transaction_transition(uuid,bigint,text,text),inventory_security.transaction_post(uuid),inventory_security.transaction_link(uuid,uuid,text) TO inventory_runtime;
COMMIT;
