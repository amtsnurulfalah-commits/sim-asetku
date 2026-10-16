BEGIN;
INSERT INTO inventory.permissions(code,description) VALUES
('approval.access','Membuka inbox dan pengajuan approval'),('procurement.approve','Menyetujui kebutuhan/pengadaan'),('receipts.approve','Menyetujui penerimaan'),('inventory.issue.approve','Menyetujui pengeluaran stok'),('inventory.adjust.approve','Menyetujui penyesuaian/koreksi stok'),('maintenance.approve','Menyetujui pemeliharaan') ON CONFLICT DO NOTHING;
INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code) SELECT r.tenant_id,r.id,p.code FROM inventory.roles r CROSS JOIN inventory.permissions p WHERE (r.code='admin' AND p.code IN ('approval.access','procurement.approve','receipts.approve','inventory.issue.approve','inventory.adjust.approve','maintenance.approve')) OR (r.code='petugas' AND p.code='approval.access') ON CONFLICT DO NOTHING;
-- Three existing roles remain. No fourth business role is introduced.
ALTER TABLE inventory.approval_actions ADD COLUMN request_digest text;
ALTER TABLE inventory.approval_actions ADD COLUMN actor_name_snapshot text;
CREATE TABLE inventory.approval_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),document_id uuid,workflow_id uuid,instance_id uuid,actor_id uuid NOT NULL,action text NOT NULL,reason text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES inventory.business_documents(tenant_id,id),FOREIGN KEY(tenant_id,workflow_id) REFERENCES inventory.approval_workflows(tenant_id,id),FOREIGN KEY(tenant_id,instance_id) REFERENCES inventory.approval_instances(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
ALTER TABLE inventory.approval_events ENABLE ROW LEVEL SECURITY;ALTER TABLE inventory.approval_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY migration_owner ON inventory.approval_events TO %I USING(true) WITH CHECK(true)',current_user);END $$;
CREATE POLICY tenant_scope ON inventory.approval_events TO inventory_runtime USING(tenant_id=inventory_security.tenant_id());
GRANT SELECT ON inventory.approval_events TO inventory_runtime;
CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.approval_events FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite();
CREATE TRIGGER audit_change AFTER INSERT ON inventory.approval_events FOR EACH ROW EXECUTE FUNCTION inventory_security.audit_change();
CREATE INDEX ON inventory.approval_events(tenant_id,document_id,created_at,id);
CREATE INDEX ON inventory.approval_events(tenant_id,workflow_id,created_at,id);
REVOKE INSERT,UPDATE,DELETE ON inventory.approval_workflows,inventory.approval_workflow_versions,inventory.approval_workflow_steps,inventory.approval_instances,inventory.approval_instance_steps,inventory.approval_actions,inventory.approval_delegations FROM inventory_runtime;
CREATE FUNCTION inventory_security.approval_permission(k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE
WHEN k IN ('supply:request','supply:order') THEN 'procurement.approve' WHEN k IN ('supply:receipt','supply:receipt_stock') THEN 'receipts.approve' WHEN k='supply:issue' THEN 'inventory.issue.approve' WHEN k='supply:adjustment' THEN 'inventory.adjust.approve'
WHEN k IN ('asset:placement','asset:movement') THEN 'movements.approve' WHEN k IN ('asset:loan','asset:return') THEN 'loans.approve' WHEN k IN ('asset:maintenance','asset:maintenance_finish') THEN 'maintenance.approve' WHEN k='asset:opname' THEN 'stockopname.approve' WHEN k='asset:disposal' THEN 'disposal.approve' END $$;
CREATE FUNCTION inventory_security.approval_member_allowed(p_member uuid,p_permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
SELECT EXISTS(SELECT FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=inventory_security.tenant_id() AND m.id=p_member AND m.status='active' AND u.status='active' AND (
EXISTS(SELECT FROM inventory.role_permissions p WHERE p.tenant_id=m.tenant_id AND p.role_id=m.role_id AND p.permission_code=p_permission) OR EXISTS(SELECT FROM inventory.membership_permission_grants p WHERE p.tenant_id=m.tenant_id AND p.membership_id=m.id AND p.permission_code=p_permission AND (p.expires_at IS NULL OR p.expires_at>clock_timestamp())))) $$;
CREATE FUNCTION inventory_security.approval_admin() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$ DECLARE actor uuid;BEGIN actor:=inventory_security.assert_tenant_admin();IF NOT inventory_security.approval_member_allowed(actor,'approval.manage') THEN RAISE EXCEPTION 'Approval admin permission required' USING ERRCODE='42501';END IF;RETURN actor;END $$;
CREATE FUNCTION inventory_security.assert_approval_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission='approval.manage' THEN RETURN inventory_security.approval_admin();ELSIF p_permission='settings.manage' THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('approval.access','procurement.approve','receipts.approve','inventory.issue.approve','inventory.adjust.approve','maintenance.approve','movements.approve','loans.approve','stockopname.approve','disposal.approve','assets.view','inventory.view','procurement.manage','inventory.receive','inventory.issue','inventory.adjust','movements.create','loans.create','maintenance.manage','stockopname.execute','disposal.create','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
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
REVOKE ALL ON FUNCTION inventory_security.assert_approval_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_approval_actor(text) TO inventory_runtime;
-- Use the same tenant-first lock order in supply entry points and engine entry points.
CREATE OR REPLACE FUNCTION inventory_security.assert_supply_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission IN ('settings.manage','approval.manage') THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('inventory.view','inventory.receive','inventory.issue','inventory.adjust','procurement.manage','assets.create','files.upload','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
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
REVOKE ALL ON FUNCTION inventory_security.assert_supply_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_supply_actor(text) TO inventory_runtime;
CREATE FUNCTION inventory_security.approval_types(p_doc uuid) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
SELECT ARRAY[d.document_type,coalesce(d.supply_kind,x.kind),CASE WHEN d.supply_kind IS NOT NULL THEN CASE d.supply_kind WHEN 'request' THEN 'procurement_request' WHEN 'order' THEN 'procurement' WHEN 'receipt' THEN 'goods_receipt' ELSE 'inventory_adjustment' END ELSE CASE x.kind WHEN 'placement' THEN 'asset_movement' WHEN 'movement' THEN 'asset_movement' WHEN 'loan' THEN 'asset_loan' WHEN 'return' THEN 'asset_return' WHEN 'maintenance' THEN 'maintenance_request' WHEN 'maintenance_finish' THEN 'maintenance_request' WHEN 'opname' THEN 'stock_opname' WHEN 'disposal' THEN 'disposal_request' END END]
FROM inventory.business_documents d LEFT JOIN inventory.asset_transactions x ON x.tenant_id=d.tenant_id AND x.id=d.id WHERE d.tenant_id=inventory_security.tenant_id() AND d.id=p_doc $$;
CREATE FUNCTION inventory_security.approval_has_workflow(p_doc uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$ SELECT EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=inventory_security.tenant_id() AND status='active' AND transaction_type=ANY(inventory_security.approval_types(p_doc))) $$;
CREATE FUNCTION inventory_security.approval_context(p_doc uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;x inventory.asset_transactions;amount numeric:=0;correction boolean:=false;BEGIN
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc;IF NOT FOUND OR inventory_security.approval_permission(d.document_type) IS NULL THEN RAISE EXCEPTION 'Unsupported approval document' USING ERRCODE='23514';END IF;
IF d.supply_kind='request' THEN SELECT coalesce(sum(round(i.quantity*i.estimated_unit_cost,2)),0) INTO amount FROM inventory.procurement_request_items i JOIN inventory.procurement_requests r ON r.tenant_id=i.tenant_id AND r.id=i.request_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind='order' THEN SELECT total_amount INTO amount FROM inventory.procurements WHERE tenant_id=t AND business_document_id=p_doc;
ELSIF d.supply_kind='receipt' THEN SELECT coalesce(sum(round(i.accepted_quantity*p.unit_cost,2)),0) INTO amount FROM inventory.goods_receipts r JOIN inventory.goods_receipt_items i ON i.tenant_id=r.tenant_id AND i.receipt_id=r.id JOIN inventory.procurement_items p ON p.tenant_id=i.tenant_id AND p.id=i.procurement_item_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind IS NOT NULL THEN
 SELECT coalesce(sum(abs(CASE WHEN i.quantity_delta<0 THEN round(i.quantity_delta*coalesce(b.stock_value/nullif(b.quantity,0),0),2) ELSE round(i.quantity_delta*i.unit_cost,2) END)),0) INTO amount FROM inventory.inventory_adjustments a JOIN inventory.inventory_transaction_lines i ON i.tenant_id=a.tenant_id AND i.adjustment_id=a.id LEFT JOIN inventory.inventory_stock_balances b ON b.tenant_id=i.tenant_id AND b.item_id=i.item_id AND b.room_id=i.room_id WHERE a.tenant_id=t AND a.business_document_id=p_doc;
 SELECT corrects_document_id IS NOT NULL INTO correction FROM inventory.inventory_adjustments WHERE tenant_id=t AND business_document_id=p_doc;
ELSE
 SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_doc;
 IF x.kind='maintenance_finish' THEN SELECT count(*)*(x.payload->>'cost')::numeric INTO amount FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=p_doc;
 ELSE SELECT coalesce(sum(a.acquisition_cost),0) INTO amount FROM inventory.asset_transaction_lines l JOIN inventory.assets a ON a.tenant_id=l.tenant_id AND a.id=l.asset_id WHERE l.tenant_id=t AND l.transaction_id=p_doc;END IF;
END IF;
RETURN jsonb_build_object('type',d.document_type,'amount',coalesce(amount,0)::text,'correction',coalesce(correction,false));END $$;
CREATE FUNCTION inventory_security.approval_authorized(p_actor uuid,p_step inventory.approval_instance_steps,p_instance inventory.approval_instances) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();workflow uuid;BEGIN
IF NOT inventory_security.approval_member_allowed(p_actor,'approval.access') OR NOT inventory_security.approval_member_allowed(p_actor,p_step.required_permission) THEN RETURN false;END IF;
IF NOT coalesce((p_instance.workflow_snapshot->>'allowSelf')::boolean,false) AND p_actor=p_instance.requested_by THEN RETURN false;END IF;
IF EXISTS(SELECT FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_instance.document_id AND kind='opname' AND (payload->>'assigneeId')::uuid=p_actor) THEN RETURN false;END IF;
IF p_actor=p_step.approver_id THEN RETURN true;END IF;
IF NOT inventory_security.approval_member_allowed(p_step.approver_id,p_step.required_permission) OR NOT inventory_security.approval_member_allowed(p_step.approver_id,'approval.access') THEN RETURN false;END IF;
SELECT workflow_id INTO workflow FROM inventory.approval_workflow_versions WHERE tenant_id=t AND id=p_instance.workflow_version_id;
RETURN EXISTS(SELECT FROM inventory.approval_delegations WHERE tenant_id=t AND from_membership_id=p_step.approver_id AND to_membership_id=p_actor AND workflow_id=workflow AND revoked_at IS NULL AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp());END $$;
CREATE FUNCTION inventory_security.approval_publish(p_id uuid,p_version bigint,p_key uuid,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;wid uuid;ver uuid;old inventory.approval_workflows;level int:=0;member uuid;step jsonb;req text:=inventory_security.approval_permission(p_data->>'type');minv numeric:=(p_data->>'minAmount')::numeric;maxv numeric:=(p_data->>'maxAmount')::numeric;prior inventory.idempotency_records;digest text;rules jsonb;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;actor:=inventory_security.approval_admin();
IF p_key IS NULL OR req IS NULL OR p_data->>'reason' IS NULL OR length(btrim(p_data->>'reason')) NOT BETWEEN 3 AND 2000 OR length(p_data->>'code') NOT BETWEEN 1 AND 64 OR length(btrim(p_data->>'name')) NOT BETWEEN 1 AND 300 OR minv IS NULL OR minv<0 OR maxv IS NOT NULL AND maxv<=minv OR p_data->>'scope' IS NULL OR p_data->>'scope' NOT IN ('all','standard','correction') OR p_data->>'scope'='correction' AND p_data->>'type'<>'supply:adjustment' OR jsonb_typeof(p_data->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'steps') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid workflow configuration' USING ERRCODE='23514';END IF;
digest:=encode(sha256(convert_to(p_data::text||actor::text||coalesce(p_id::text,'new')||coalesce(p_version::text,'new'),'UTF8')),'hex');
SELECT * INTO prior FROM inventory.idempotency_records WHERE tenant_id=t AND operation='approval.publish' AND idempotency_key=p_key::text;
IF FOUND THEN IF prior.request_digest<>digest THEN RAISE EXCEPTION 'Idempotency mismatch' USING ERRCODE='23514';END IF;RETURN prior.resource_id;END IF;
IF p_id IS NULL THEN INSERT INTO inventory.approval_workflows(tenant_id,code,name,transaction_type,status) VALUES(t,p_data->>'code',p_data->>'name',p_data->>'type',CASE WHEN (p_data->>'enabled')::boolean THEN 'active' ELSE 'archived' END) RETURNING id INTO wid;
ELSE SELECT * INTO old FROM inventory.approval_workflows WHERE tenant_id=t AND id=p_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;IF p_version IS NULL OR old.row_version<>p_version THEN RAISE EXCEPTION 'Stale workflow' USING ERRCODE='40001';END IF;IF old.code<>p_data->>'code' OR old.transaction_type<>p_data->>'type' THEN RAISE EXCEPTION 'Workflow identity immutable' USING ERRCODE='23514';END IF;wid:=old.id;UPDATE inventory.approval_workflows SET name=p_data->>'name',status=CASE WHEN (p_data->>'enabled')::boolean THEN 'active' ELSE 'archived' END WHERE id=wid;END IF;
rules:=jsonb_build_object('minAmount',minv::text,'maxAmount',maxv::text,'scope',p_data->>'scope','reject',coalesce((p_data->>'allowReject')::boolean,true),'revision',coalesce((p_data->>'allowRevision')::boolean,true));
IF (p_data->>'enabled')::boolean AND EXISTS(SELECT FROM inventory.approval_workflows w JOIN LATERAL (SELECT activation_conditions c FROM inventory.approval_workflow_versions WHERE tenant_id=t AND workflow_id=w.id AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1) v ON true WHERE w.tenant_id=t AND w.id<>wid AND w.transaction_type=p_data->>'type' AND w.status='active' AND (rules->>'scope'='all' OR v.c->>'scope'='all' OR rules->>'scope'=v.c->>'scope') AND (maxv IS NULL OR (v.c->>'minAmount')::numeric<maxv) AND (v.c->>'maxAmount' IS NULL OR minv<(v.c->>'maxAmount')::numeric)) THEN RAISE EXCEPTION 'Overlapping active workflow ranges' USING ERRCODE='23514';END IF;
INSERT INTO inventory.approval_workflow_versions(tenant_id,workflow_id,version,activation_conditions,allow_self_approval) VALUES(t,wid,coalesce((SELECT max(version)+1 FROM inventory.approval_workflow_versions WHERE tenant_id=t AND workflow_id=wid),1),rules,coalesce((p_data->>'allowSelf')::boolean,false)) RETURNING id INTO ver;
FOR step IN SELECT value FROM jsonb_array_elements(p_data->'steps') LOOP
 member:=(step#>>'{}')::uuid;level:=level+1;
 IF NOT inventory_security.approval_member_allowed(member,req) OR NOT inventory_security.approval_member_allowed(member,'approval.access') THEN RAISE EXCEPTION 'Approver must be active with required permissions' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.approval_workflow_steps(tenant_id,workflow_version_id,level,approver_id,required_permission) VALUES(t,ver,level,member,req);
END LOOP;
UPDATE inventory.approval_workflow_versions SET published_at=clock_timestamp() WHERE id=ver;
INSERT INTO inventory.approval_events(tenant_id,workflow_id,actor_id,action,reason,details) VALUES(t,wid,actor,'publish',p_data->>'reason',jsonb_build_object('versionId',ver,'rules',rules,'allowSelf',coalesce((p_data->>'allowSelf')::boolean,false)));
INSERT INTO inventory.idempotency_records(tenant_id,operation,idempotency_key,request_digest,resource_id,expires_at) VALUES(t,'approval.publish',p_key::text,digest,wid,clock_timestamp()+interval '10 years');RETURN wid;END $$;
CREATE FUNCTION inventory_security.approval_workflow_state(p_id uuid,p_version bigint,p_enabled boolean,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;actor:=inventory_security.approval_admin();
IF p_enabled IS DISTINCT FROM false THEN RAISE EXCEPTION 'Activate by publishing a validated version' USING ERRCODE='23514';END IF;
IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514';END IF;
UPDATE inventory.approval_workflows SET status='archived' WHERE tenant_id=t AND id=p_id AND row_version=p_version;IF NOT FOUND THEN RAISE EXCEPTION 'Stale workflow' USING ERRCODE='40001';END IF;
INSERT INTO inventory.approval_events(tenant_id,workflow_id,actor_id,action,reason) VALUES(t,p_id,actor,'deactivate',p_reason);END $$;
CREATE FUNCTION inventory_security.protect_approval_steps() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,inventory AS $$ BEGIN
IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT FROM inventory.approval_workflow_versions WHERE tenant_id=OLD.tenant_id AND id=OLD.workflow_version_id AND published_at IS NOT NULL) OR TG_OP IN ('INSERT','UPDATE') AND EXISTS(SELECT FROM inventory.approval_workflow_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.workflow_version_id AND published_at IS NOT NULL) THEN RAISE EXCEPTION 'Published steps immutable; publish a new version' USING ERRCODE='23514';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE TRIGGER published_steps BEFORE INSERT OR UPDATE OR DELETE ON inventory.approval_workflow_steps FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_approval_steps();
CREATE FUNCTION inventory_security.approval_set_status(p_doc uuid,p_status text,p_revision integer DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();k text;tab text;BEGIN
UPDATE inventory.business_documents SET status=p_status,revision=coalesce(p_revision,revision) WHERE tenant_id=t AND id=p_doc RETURNING supply_kind INTO k;
IF k IS NOT NULL THEN tab:=inventory_security.supply_source(k);EXECUTE format('UPDATE inventory.%I SET status=$1,revision=coalesce($2,revision) WHERE tenant_id=$3 AND business_document_id=$4',tab) USING p_status,p_revision,t,p_doc;END IF;END $$;
CREATE FUNCTION inventory_security.approval_payload(p_doc uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;rows jsonb;BEGIN
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc;
IF d.supply_kind='request' THEN SELECT jsonb_agg(jsonb_build_object('name',i.description,'quantity',i.quantity::text,'unitCost',i.estimated_unit_cost::text,'unit',u.name) ORDER BY i.line_number) INTO rows FROM inventory.procurement_requests r JOIN inventory.procurement_request_items i ON i.tenant_id=r.tenant_id AND i.request_id=r.id JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind='order' THEN SELECT jsonb_agg(jsonb_build_object('name',i.description,'quantity',i.quantity::text,'unitCost',i.unit_cost::text,'unit',u.name,'destination',i.destination_kind) ORDER BY i.line_number) INTO rows FROM inventory.procurements r JOIN inventory.procurement_items i ON i.tenant_id=r.tenant_id AND i.procurement_id=r.id JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind='receipt' THEN SELECT jsonb_agg(jsonb_build_object('name',p.description,'quantity',i.quantity::text,'accepted',i.accepted_quantity::text,'unitCost',p.unit_cost::text,'room',room.name,'notes',i.inspection_notes) ORDER BY i.line_number) INTO rows FROM inventory.goods_receipts r JOIN inventory.goods_receipt_items i ON i.tenant_id=r.tenant_id AND i.receipt_id=r.id JOIN inventory.procurement_items p ON p.tenant_id=i.tenant_id AND p.id=i.procurement_item_id JOIN inventory.rooms room ON room.tenant_id=i.tenant_id AND room.id=i.room_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind IS NOT NULL THEN SELECT jsonb_agg(jsonb_build_object('name',item.name,'quantity',i.quantity_delta::text,'unitCost',i.unit_cost::text,'room',room.name) ORDER BY i.line_number) INTO rows FROM inventory.inventory_adjustments r JOIN inventory.inventory_transaction_lines i ON i.tenant_id=r.tenant_id AND i.adjustment_id=r.id JOIN inventory.inventory_items item ON item.tenant_id=i.tenant_id AND item.id=i.item_id JOIN inventory.rooms room ON room.tenant_id=i.tenant_id AND room.id=i.room_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSE SELECT jsonb_agg(jsonb_build_object('name',l.snapshot->>'name','code',l.snapshot->>'code','room',room.name,'condition',cond.name,'finding',l.observation->>'finding','observedRoom',observed.name,'observedCondition',oc.name,'notes',l.observation->>'notes') ORDER BY l.snapshot->>'code') INTO rows FROM inventory.asset_transaction_lines l LEFT JOIN inventory.rooms room ON room.tenant_id=l.tenant_id AND room.id=(l.snapshot->>'roomId')::uuid LEFT JOIN inventory.asset_conditions cond ON cond.tenant_id=l.tenant_id AND cond.id=(l.snapshot->>'conditionId')::uuid LEFT JOIN inventory.rooms observed ON observed.tenant_id=l.tenant_id AND observed.id=(l.observation->>'roomId')::uuid LEFT JOIN inventory.asset_conditions oc ON oc.tenant_id=l.tenant_id AND oc.id=(l.observation->>'conditionId')::uuid WHERE l.tenant_id=t AND l.transaction_id=p_doc;
END IF;
RETURN jsonb_build_object('input',d.input_snapshot,'sourceRevision',d.source_revision,'summary',jsonb_build_object('documentNumber',d.document_number,'date',d.business_date::text,'reason',d.supply_reason,'borrower',d.input_snapshot->>'borrower','startAt',d.input_snapshot->>'startAt','dueAt',d.input_snapshot->>'dueAt','completedAt',d.input_snapshot->>'completedAt','targetRoom',(SELECT name FROM inventory.rooms WHERE tenant_id=t AND id=(d.input_snapshot->>'roomId')::uuid),'targetCondition',(SELECT name FROM inventory.asset_conditions WHERE tenant_id=t AND id=(d.input_snapshot->>'conditionId')::uuid),'responsible',(SELECT u.full_name_snapshot FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=t AND m.id=(d.input_snapshot->>'responsibleId')::uuid),'costTreatment',d.input_snapshot->>'costTreatment','lines',coalesce(rows,'[]'::jsonb),'unregistered',coalesce((SELECT jsonb_agg(reason ORDER BY created_at) FROM inventory.asset_transaction_events WHERE tenant_id=t AND transaction_id=p_doc AND action='unregistered'),'[]'::jsonb)),
'assetLines',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM inventory.asset_transaction_lines l WHERE l.tenant_id=t AND l.transaction_id=p_doc),'[]'::jsonb),
'files',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',f.original_filename,'sensitivity',f.sensitivity,'checksum',f.checksum) ORDER BY a.id) FROM inventory.document_attachments a JOIN inventory.file_attachments f ON f.tenant_id=a.tenant_id AND f.id=a.file_id WHERE a.tenant_id=t AND a.document_id=p_doc AND f.status='ready'),'[]'::jsonb));END $$;
CREATE FUNCTION inventory_security.approval_submit(p_doc uuid,p_version bigint,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;ctx jsonb;w inventory.approval_workflows;v inventory.approval_workflow_versions;r record;chosen uuid;matches int:=0;iid uuid;st inventory.approval_instance_steps;inst inventory.approval_instances;workflow_json jsonb;revision int;eligible boolean;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_approval_actor(CASE WHEN d.supply_kind IS NOT NULL THEN inventory_security.supply_permission(d.supply_kind) ELSE inventory_security.transaction_permission(substr(d.document_type,7)) END);
IF d.requested_by<>actor OR d.status NOT IN ('draft','revision_required') THEN RAISE EXCEPTION 'Owner editable document required' USING ERRCODE='42501';END IF;
IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514';END IF;
IF d.document_type='asset:opname' AND EXISTS(SELECT FROM inventory.asset_transaction_lines WHERE tenant_id=t AND transaction_id=p_doc AND checked_at IS NULL) THEN RAISE EXCEPTION 'Complete all inspections first' USING ERRCODE='23514';END IF;
IF d.document_type='asset:disposal' AND NOT EXISTS(SELECT FROM inventory.document_attachments a JOIN inventory.file_attachments f ON f.tenant_id=a.tenant_id AND f.id=a.file_id WHERE a.tenant_id=t AND a.document_id=p_doc AND f.status='ready') THEN RAISE EXCEPTION 'Disposal evidence required' USING ERRCODE='23514';END IF;
ctx:=inventory_security.approval_context(p_doc);
FOR r IN SELECT wf.id,wf.transaction_type,vv.id version_id,vv.activation_conditions c FROM inventory.approval_workflows wf LEFT JOIN LATERAL (SELECT * FROM inventory.approval_workflow_versions WHERE tenant_id=t AND workflow_id=wf.id AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1) vv ON true WHERE wf.tenant_id=t AND wf.status='active' AND wf.transaction_type=ANY(inventory_security.approval_types(p_doc)) LOOP
 IF r.transaction_type<>d.document_type OR r.version_id IS NULL THEN RAISE EXCEPTION 'General approval workflow requires a published supported version' USING ERRCODE='23514';END IF;
 IF (ctx->>'amount')::numeric>=(r.c->>'minAmount')::numeric AND (r.c->>'maxAmount' IS NULL OR (ctx->>'amount')::numeric<(r.c->>'maxAmount')::numeric) AND (r.c->>'scope'='all' OR (r.c->>'scope'='correction')=(ctx->>'correction')::boolean) THEN chosen:=r.version_id;matches:=matches+1;END IF;
END LOOP;
IF matches<>1 THEN RAISE EXCEPTION 'Exactly one matching workflow required; no fallback' USING ERRCODE='23514';END IF;
SELECT * INTO v FROM inventory.approval_workflow_versions WHERE tenant_id=t AND id=chosen;SELECT * INTO w FROM inventory.approval_workflows WHERE tenant_id=t AND id=v.workflow_id;
IF NOT EXISTS(SELECT FROM inventory.approval_workflow_steps WHERE tenant_id=t AND workflow_version_id=v.id) THEN RAISE EXCEPTION 'Active approvers required' USING ERRCODE='23514';END IF;
revision:=d.revision;
IF EXISTS(SELECT FROM inventory.approval_instances WHERE tenant_id=t AND document_id=p_doc AND document_revision=revision) THEN
 IF d.status<>'revision_required' THEN RAISE EXCEPTION 'Revision already submitted' USING ERRCODE='23514';END IF;revision:=revision+1;
END IF;
PERFORM inventory_security.approval_set_status(p_doc,'submitted',revision);
workflow_json:=jsonb_build_object('workflowId',w.id,'code',w.code,'name',w.name,'type',w.transaction_type,'version',v.version,'allowSelf',v.allow_self_approval,'rules',v.activation_conditions,'steps',(SELECT jsonb_agg(jsonb_build_object('level',s.level,'approverId',s.approver_id,'name',u.full_name_snapshot,'permission',s.required_permission) ORDER BY s.level) FROM inventory.approval_workflow_steps s JOIN inventory.tenant_memberships m ON m.tenant_id=s.tenant_id AND m.id=s.approver_id JOIN inventory.app_users u ON u.id=m.app_user_id WHERE s.tenant_id=t AND s.workflow_version_id=v.id));
INSERT INTO inventory.approval_instances(tenant_id,document_id,document_revision,workflow_version_id,requested_by,workflow_snapshot,payload_snapshot,status) VALUES(t,p_doc,revision,v.id,actor,workflow_json,inventory_security.approval_payload(p_doc)||jsonb_build_object('context',ctx),'pending') RETURNING id INTO iid;
INSERT INTO inventory.approval_instance_steps(tenant_id,instance_id,level,approver_id,required_permission) SELECT t,iid,level,approver_id,required_permission FROM inventory.approval_workflow_steps WHERE tenant_id=t AND workflow_version_id=v.id ORDER BY level;
SELECT * INTO inst FROM inventory.approval_instances WHERE id=iid;
FOR st IN SELECT * FROM inventory.approval_instance_steps WHERE tenant_id=t AND instance_id=iid LOOP
 eligible:=false;
 IF inventory_security.approval_authorized(st.approver_id,st,inst) THEN eligible:=true;END IF;
 IF NOT eligible AND EXISTS(SELECT FROM inventory.approval_delegations dg WHERE dg.tenant_id=t AND dg.from_membership_id=st.approver_id AND dg.workflow_id=w.id AND dg.revoked_at IS NULL AND dg.starts_at<=clock_timestamp() AND dg.ends_at>clock_timestamp() AND inventory_security.approval_authorized(dg.to_membership_id,st,inst)) THEN eligible:=true;END IF;
 IF NOT eligible THEN RAISE EXCEPTION 'No eligible independent active approver for a level' USING ERRCODE='23514';END IF;
END LOOP;
UPDATE inventory.business_documents SET review_mode_snapshot='engine_v1' WHERE tenant_id=t AND id=p_doc;
PERFORM inventory_security.approval_set_status(p_doc,'pending');
INSERT INTO inventory.approval_events(tenant_id,document_id,workflow_id,instance_id,actor_id,action,reason,details) VALUES(t,p_doc,w.id,iid,actor,'submit',p_reason,jsonb_build_object('revision',revision,'amount',ctx->>'amount'));
RETURN iid;END $$;
CREATE FUNCTION inventory_security.approval_decide(p_instance uuid,p_version bigint,p_level integer,p_decision text,p_reason text,p_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;inst inventory.approval_instances;st inventory.approval_instance_steps;d inventory.business_documents;prior inventory.approval_actions;digest text;state text;last_level int;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;actor:=inventory_security.assert_approval_actor('approval.access');
IF p_level IS NULL OR p_level NOT BETWEEN 1 AND 10 OR p_key IS NULL OR p_decision NOT IN ('approved','rejected','revision_required') OR p_decision IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Decision and reason required' USING ERRCODE='23514';END IF;
digest:=encode(sha256(convert_to(p_instance::text||p_level::text||p_decision||p_reason||actor::text,'UTF8')),'hex');
SELECT * INTO prior FROM inventory.approval_actions WHERE tenant_id=t AND idempotency_key=p_key::text;
IF FOUND THEN IF prior.request_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'Idempotency mismatch' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('reused',true);END IF;
SELECT * INTO inst FROM inventory.approval_instances WHERE tenant_id=t AND id=p_instance FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=inst.document_id FOR UPDATE;
IF p_version IS NULL OR inst.row_version<>p_version THEN RAISE EXCEPTION 'Stale approval' USING ERRCODE='40001';END IF;
IF inst.status NOT IN ('pending','partially_approved') OR d.status NOT IN ('pending','partially_approved') OR d.review_mode_snapshot IS DISTINCT FROM 'engine_v1' OR d.revision<>inst.document_revision OR inst.current_level<>p_level OR (inst.payload_snapshot->>'sourceRevision')::integer<>d.source_revision OR inst.payload_snapshot->'input' IS DISTINCT FROM d.input_snapshot THEN RAISE EXCEPTION 'Approval order or snapshot invalid' USING ERRCODE='23514';END IF;
SELECT * INTO st FROM inventory.approval_instance_steps WHERE tenant_id=t AND instance_id=inst.id AND level=inst.current_level FOR UPDATE;
IF st.status<>'pending' OR NOT inventory_security.approval_authorized(actor,st,inst) THEN RAISE EXCEPTION 'Not assigned active approver at current level' USING ERRCODE='42501';END IF;
PERFORM inventory_security.assert_approval_actor(st.required_permission);
IF p_decision='rejected' AND NOT (inst.workflow_snapshot->'rules'->>'reject')::boolean OR p_decision='revision_required' AND NOT (inst.workflow_snapshot->'rules'->>'revision')::boolean THEN RAISE EXCEPTION 'Decision disabled by snapshot policy' USING ERRCODE='23514';END IF;
INSERT INTO inventory.approval_actions(tenant_id,instance_step_id,actor_id,decision,reason,idempotency_key,request_digest,actor_name_snapshot) VALUES(t,st.id,actor,p_decision,p_reason,p_key::text,digest,(SELECT u.full_name_snapshot FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=t AND m.id=actor));
UPDATE inventory.approval_instance_steps SET status=p_decision WHERE id=st.id;
SELECT max(level) INTO last_level FROM inventory.approval_instance_steps WHERE tenant_id=t AND instance_id=inst.id;
state:=CASE WHEN p_decision<>'approved' THEN p_decision WHEN inst.current_level=last_level THEN 'approved' ELSE 'partially_approved' END;
UPDATE inventory.approval_instances SET status=state,current_level=CASE WHEN state='partially_approved' THEN current_level+1 ELSE current_level END,finalized_at=CASE WHEN state='partially_approved' THEN NULL ELSE clock_timestamp() END WHERE id=inst.id;
IF state IN ('rejected','revision_required') THEN UPDATE inventory.approval_instance_steps SET status='cancelled' WHERE tenant_id=t AND instance_id=inst.id AND status='pending';END IF;
PERFORM inventory_security.approval_set_status(d.id,state);
INSERT INTO inventory.approval_events(tenant_id,document_id,instance_id,actor_id,action,reason,details) VALUES(t,d.id,inst.id,actor,p_decision,p_reason,jsonb_build_object('level',st.level,'assignedTo',st.approver_id));
RETURN jsonb_build_object('status',state,'reused',false);END $$;
CREATE FUNCTION inventory_security.approval_cancel(p_doc uuid,p_version bigint,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;inst inventory.approval_instances;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_approval_actor(CASE WHEN d.supply_kind IS NOT NULL THEN inventory_security.supply_permission(d.supply_kind) ELSE inventory_security.transaction_permission(substr(d.document_type,7)) END);
IF d.requested_by<>actor THEN RAISE EXCEPTION 'Owner cancellation required' USING ERRCODE='42501';END IF;
IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
IF d.status NOT IN ('pending','partially_approved','revision_required','draft','rejected') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Not cancellable' USING ERRCODE='23514';END IF;
SELECT * INTO inst FROM inventory.approval_instances WHERE tenant_id=t AND document_id=p_doc AND document_revision=d.revision FOR UPDATE;
IF inst.status IN ('pending','partially_approved') THEN
UPDATE inventory.approval_instances SET status='cancelled',finalized_at=clock_timestamp() WHERE id=inst.id;UPDATE inventory.approval_instance_steps SET status='cancelled' WHERE tenant_id=t AND instance_id=inst.id AND status='pending';END IF;
PERFORM inventory_security.approval_set_status(p_doc,'cancelled');
INSERT INTO inventory.approval_events(tenant_id,document_id,instance_id,actor_id,action,reason) VALUES(t,p_doc,inst.id,actor,'cancel',p_reason);END $$;
CREATE FUNCTION inventory_security.approval_return(p_doc uuid,p_version bigint,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;inst inventory.approval_instances;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;actor:=inventory_security.approval_admin();SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
IF d.status<>'approved' OR d.review_mode_snapshot IS DISTINCT FROM 'engine_v1' OR d.requested_by=actor OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Independent admin and unposted approved document required' USING ERRCODE='42501';END IF;
SELECT * INTO inst FROM inventory.approval_instances WHERE tenant_id=t AND document_id=p_doc AND document_revision=d.revision AND status='approved';
IF inst.id IS NULL OR NOT (inst.workflow_snapshot->'rules'->>'revision')::boolean THEN RAISE EXCEPTION 'Revision disabled' USING ERRCODE='23514';END IF;
IF EXISTS(SELECT FROM inventory.procurements WHERE tenant_id=t AND request_id=(SELECT id FROM inventory.procurement_requests WHERE tenant_id=t AND business_document_id=p_doc)) OR EXISTS(SELECT FROM inventory.goods_receipts WHERE tenant_id=t AND procurement_id=(SELECT id FROM inventory.procurements WHERE tenant_id=t AND business_document_id=p_doc)) THEN RAISE EXCEPTION 'Approved source already consumed' USING ERRCODE='23514';END IF;
PERFORM inventory_security.approval_set_status(p_doc,'revision_required');
INSERT INTO inventory.approval_events(tenant_id,document_id,instance_id,actor_id,action,reason) VALUES(t,p_doc,inst.id,actor,'return_for_revision',p_reason);END $$;
CREATE FUNCTION inventory_security.approval_assert_post(p_doc uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;i inventory.approval_instances;ctx jsonb;BEGIN
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc;SELECT * INTO i FROM inventory.approval_instances WHERE tenant_id=t AND document_id=p_doc AND document_revision=d.revision;
IF d.status IS DISTINCT FROM 'approved' OR d.review_mode_snapshot IS DISTINCT FROM 'engine_v1' OR i.status IS DISTINCT FROM 'approved' OR i.payload_snapshot->'input' IS DISTINCT FROM d.input_snapshot OR (i.payload_snapshot->>'sourceRevision')::int<>d.source_revision OR NOT EXISTS(SELECT FROM inventory.approval_instance_steps WHERE tenant_id=t AND instance_id=i.id) OR EXISTS(SELECT FROM inventory.approval_instance_steps s WHERE s.tenant_id=t AND s.instance_id=i.id AND (s.status<>'approved' OR NOT EXISTS(SELECT FROM inventory.approval_actions a WHERE a.tenant_id=t AND a.instance_step_id=s.id AND a.decision='approved'))) THEN RAISE EXCEPTION 'Complete immutable engine approval required' USING ERRCODE='42501';END IF;
IF EXISTS(SELECT FROM jsonb_array_elements(i.payload_snapshot->'files') snap WHERE NOT EXISTS(SELECT FROM inventory.file_attachments f WHERE f.tenant_id=t AND f.id=(snap->>'id')::uuid AND f.status='ready' AND f.checksum IS NOT DISTINCT FROM snap->>'checksum')) THEN RAISE EXCEPTION 'Reviewed file missing or changed; new approval required' USING ERRCODE='23514';END IF;
ctx:=inventory_security.approval_context(p_doc);
IF (ctx->>'amount')::numeric>(i.payload_snapshot->'context'->>'amount')::numeric THEN RAISE EXCEPTION 'Material amount increased; new approval required' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION inventory_security.approval_delegate(p_id uuid,p_version bigint,p_from uuid,p_to uuid,p_workflow uuid,p_start timestamptz,p_end timestamptz,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;req text;result uuid;wid uuid:=p_workflow;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;actor:=inventory_security.approval_admin();
IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514';END IF;
IF p_id IS NOT NULL THEN
 UPDATE inventory.approval_delegations SET revoked_at=clock_timestamp() WHERE tenant_id=t AND id=p_id AND row_version=p_version AND revoked_at IS NULL RETURNING id,workflow_id INTO result,wid;
 IF result IS NULL THEN RAISE EXCEPTION 'Stale delegation' USING ERRCODE='40001';END IF;
ELSE
 SELECT inventory_security.approval_permission(transaction_type) INTO req FROM inventory.approval_workflows WHERE tenant_id=t AND id=p_workflow;
 IF req IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from=p_to OR p_start IS NULL OR p_end IS NULL OR p_end<=p_start OR p_end<=clock_timestamp() OR p_end>p_start+interval '90 days' OR NOT inventory_security.approval_member_allowed(p_from,req) OR NOT inventory_security.approval_member_allowed(p_to,req) OR NOT inventory_security.approval_member_allowed(p_from,'approval.access') OR NOT inventory_security.approval_member_allowed(p_to,'approval.access') THEN RAISE EXCEPTION 'Active scoped delegation required; maximum 90 days' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM inventory.approval_delegations WHERE tenant_id=t AND from_membership_id=p_from AND workflow_id=p_workflow AND revoked_at IS NULL AND starts_at<p_end AND ends_at>p_start) THEN RAISE EXCEPTION 'Overlapping delegation' USING ERRCODE='23514';END IF;
 INSERT INTO inventory.approval_delegations(tenant_id,from_membership_id,to_membership_id,workflow_id,starts_at,ends_at,reason) VALUES(t,p_from,p_to,p_workflow,p_start,p_end,p_reason) RETURNING id INTO result;
END IF;
INSERT INTO inventory.approval_events(tenant_id,workflow_id,actor_id,action,reason,details) VALUES(t,wid,actor,CASE WHEN p_id IS NULL THEN 'delegate' ELSE 'revoke_delegation' END,p_reason,jsonb_build_object('delegationId',result,'from',p_from,'to',p_to));RETURN result;END $$;
CREATE FUNCTION inventory_security.approval_directory() RETURNS TABLE(id uuid,name text,permissions text[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();BEGIN
PERFORM inventory_security.approval_admin();
RETURN QUERY SELECT m.id,u.full_name_snapshot,ARRAY(SELECT p.permission_code FROM inventory.role_permissions p WHERE p.tenant_id=t AND p.role_id=m.role_id UNION SELECT g.permission_code FROM inventory.membership_permission_grants g WHERE g.tenant_id=t AND g.membership_id=m.id AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) ORDER BY 1) FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=t AND m.status='active' AND u.status='active' ORDER BY u.full_name_snapshot LIMIT 1000;END $$;
CREATE FUNCTION inventory_security.approval_can_see(p_instance uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();m uuid:=nullif(current_setting('app.membership_id',true),'')::uuid;i inventory.approval_instances;BEGIN
SELECT * INTO i FROM inventory.approval_instances WHERE tenant_id=t AND id=p_instance;IF NOT FOUND THEN RETURN false;END IF;
RETURN i.requested_by=m OR EXISTS(SELECT FROM inventory.approval_actions aa JOIN inventory.approval_instance_steps ss ON ss.tenant_id=aa.tenant_id AND ss.id=aa.instance_step_id WHERE aa.tenant_id=t AND aa.actor_id=m AND ss.instance_id=i.id) OR EXISTS(SELECT FROM inventory.tenant_memberships tm JOIN inventory.roles r ON r.tenant_id=tm.tenant_id AND r.id=tm.role_id WHERE tm.tenant_id=t AND tm.id=m AND tm.status='active' AND r.code='admin') OR EXISTS(SELECT FROM inventory.approval_instance_steps s WHERE s.tenant_id=t AND s.instance_id=i.id AND (s.approver_id=m OR inventory_security.approval_authorized(m,s,i)));END $$;
ALTER FUNCTION inventory_security.seed_tenant(uuid) RENAME TO seed_tenant_before_approval;
CREATE FUNCTION inventory_security.seed_tenant(p_tenant uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,inventory AS $$ BEGIN
PERFORM inventory_security.seed_tenant_before_approval(p_tenant);
INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code) SELECT r.tenant_id,r.id,'approval.access' FROM inventory.roles r WHERE r.tenant_id=p_tenant AND r.code IN ('admin','petugas') ON CONFLICT DO NOTHING;END $$;

CREATE OR REPLACE FUNCTION inventory_security.supply_transition(p_id uuid,p_version bigint,p_action text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;actor uuid;state text;tab text;mode text;source uuid;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id AND supply_kind IS NOT NULL FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
IF p_action='revision' AND d.status='approved' AND d.review_mode_snapshot<>'engine_v1' AND (EXISTS(SELECT FROM inventory.procurements WHERE tenant_id=t AND request_id=(SELECT id FROM inventory.procurement_requests WHERE tenant_id=t AND business_document_id=p_id)) OR EXISTS(SELECT FROM inventory.goods_receipts WHERE tenant_id=t AND procurement_id=(SELECT id FROM inventory.procurements WHERE tenant_id=t AND business_document_id=p_id))) THEN RAISE EXCEPTION 'Approved source already consumed' USING ERRCODE='23514';END IF;
IF p_action='submit' AND inventory_security.approval_has_workflow(p_id) THEN PERFORM inventory_security.approval_submit(p_id,p_version,p_reason);RETURN;END IF;
IF d.review_mode_snapshot='engine_v1' THEN
 IF p_action='cancel' THEN PERFORM inventory_security.approval_cancel(p_id,p_version,p_reason);RETURN;
 ELSIF p_action='revision' AND d.status='approved' THEN PERFORM inventory_security.approval_return(p_id,p_version,p_reason);RETURN;
 ELSE RAISE EXCEPTION 'Use approval inbox for engine decisions' USING ERRCODE='23514';END IF;
END IF;
actor:=inventory_security.assert_supply_actor(CASE WHEN p_action IN ('review','approve','reject','revision') THEN 'approval.manage' ELSE inventory_security.supply_permission(d.supply_kind) END);
IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
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
 ELSIF d.status='pending' OR p_action='revision' AND d.status='approved' THEN state:=CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'revision' THEN 'revision_required' END;
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
CREATE OR REPLACE FUNCTION inventory_security.transaction_transition(p_id uuid,p_version bigint,p_action text,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;x inventory.asset_transactions;actor uuid;state text;mode text;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id;SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;
IF x.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
IF p_action='submit' AND inventory_security.approval_has_workflow(p_id) THEN PERFORM inventory_security.approval_submit(p_id,p_version,p_reason);RETURN;END IF;
IF d.review_mode_snapshot='engine_v1' THEN
 IF p_action='cancel' THEN PERFORM inventory_security.approval_cancel(p_id,p_version,p_reason);RETURN;
 ELSIF p_action='revision' AND d.status='approved' THEN PERFORM inventory_security.approval_return(p_id,p_version,p_reason);RETURN;
 ELSE RAISE EXCEPTION 'Use approval inbox for engine decisions' USING ERRCODE='23514';END IF;
END IF;
actor:=inventory_security.assert_transaction_actor(CASE WHEN p_action IN ('review','approve','reject','revision') THEN 'approval.manage' ELSE inventory_security.transaction_permission(x.kind) END);
IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale version' USING ERRCODE='40001';END IF;
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
CREATE OR REPLACE FUNCTION inventory_security.supply_post(p_id uuid,p_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;actor uuid;source uuid;tab text;l record;oi inventory.procurement_items;ord inventory.procurements;created jsonb;asset_id uuid;template jsonb;line_value numeric;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id AND supply_kind IS NOT NULL FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_supply_actor(inventory_security.supply_permission(d.supply_kind));
IF d.supply_kind IN ('request','order') OR p_key IS NULL THEN RAISE EXCEPTION 'Only receipts and stock transactions are postable' USING ERRCODE='23514';END IF;
IF d.status='posted' THEN RETURN jsonb_build_object('posted',true,'reused',true);END IF;
IF d.review_mode_snapshot='engine_v1' THEN PERFORM inventory_security.approval_assert_post(p_id);ELSE
IF d.status<>'approved' OR d.review_mode_snapshot IS DISTINCT FROM 'single_admin_v1' OR NOT EXISTS(SELECT FROM inventory.supply_review_events WHERE tenant_id=t AND document_id=d.id AND revision=d.revision AND action='approve' AND actor_id<>d.requested_by) THEN RAISE EXCEPTION 'Independent approved document required' USING ERRCODE='42501';END IF;
IF EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (d.document_type,d.supply_kind,CASE WHEN d.supply_kind='receipt' THEN 'goods_receipt' ELSE 'inventory_adjustment' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
END IF;
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
CREATE OR REPLACE FUNCTION inventory_security.transaction_post(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;x inventory.asset_transactions;l inventory.asset_transaction_lines;a inventory.assets;v jsonb;source uuid;li uuid;rec uuid;n int:=0;parent_source uuid;oldcond uuid;oldroom uuid;foundsource uuid;
BEGIN
-- Coarse tenant lock intentionally serializes business transactions; lock order is tenant -> document -> assets sorted UUID.
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;SELECT * INTO x FROM inventory.asset_transactions WHERE tenant_id=t AND id=p_id;
IF x.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_transaction_actor(inventory_security.transaction_permission(x.kind));
IF d.status='posted' THEN RETURN jsonb_build_object('id',p_id,'reused',true);END IF;
IF d.review_mode_snapshot='engine_v1' THEN PERFORM inventory_security.approval_assert_post(p_id);ELSE
IF d.status<>'approved' OR d.review_mode_snapshot IS DISTINCT FROM 'single_admin_v1' OR NOT EXISTS(SELECT FROM inventory.asset_transaction_events WHERE tenant_id=t AND transaction_id=p_id AND action='approve' AND revision=d.revision AND actor_id<>d.requested_by) THEN RAISE EXCEPTION 'Independent approved revision required' USING ERRCODE='42501';END IF;
IF EXISTS(SELECT FROM inventory.approval_workflows WHERE tenant_id=t AND status='active' AND transaction_type IN (x.kind,d.document_type,CASE x.kind WHEN 'placement' THEN 'asset_movement' WHEN 'movement' THEN 'asset_movement' WHEN 'loan' THEN 'asset_loan' WHEN 'return' THEN 'asset_return' WHEN 'maintenance' THEN 'maintenance_request' WHEN 'maintenance_finish' THEN 'maintenance_request' WHEN 'opname' THEN 'stock_opname' WHEN 'disposal' THEN 'disposal_request' END)) THEN RAISE EXCEPTION 'General approval engine required' USING ERRCODE='23514';END IF;
END IF;
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
CREATE FUNCTION inventory_security.approval_read(p_instance uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;i inventory.approval_instances;d inventory.business_documents;canact boolean;st inventory.approval_instance_steps;BEGIN
actor:=inventory_security.assert_approval_actor('approval.access');
IF NOT inventory_security.approval_can_see(p_instance) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
SELECT * INTO i FROM inventory.approval_instances WHERE tenant_id=t AND id=p_instance;SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=i.document_id;
SELECT * INTO st FROM inventory.approval_instance_steps WHERE tenant_id=t AND instance_id=i.id AND level=i.current_level;
canact:=i.status IN ('pending','partially_approved') AND d.status IN ('pending','partially_approved') AND i.document_revision=d.revision AND inventory_security.approval_authorized(actor,st,i);
RETURN jsonb_build_object('id',i.id,'rowVersion',i.row_version::text,'documentId',d.id,'documentVersion',d.row_version::text,'documentNumber',d.document_number,'type',d.document_type,'documentStatus',d.status,'currentRevision',d.revision,'revision',i.document_revision,'status',i.status,'currentLevel',i.current_level,'requestedBy',i.requested_by,'requestedName',(SELECT u.full_name_snapshot FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=t AND m.id=i.requested_by),'workflow',i.workflow_snapshot,'summary',i.payload_snapshot->'summary','amount',i.payload_snapshot->'context'->>'amount','canDecide',coalesce(canact,false),'isOwner',actor=i.requested_by,'steps',
(SELECT jsonb_agg(jsonb_build_object('id',s.id,'level',s.level,'approverId',s.approver_id,'name',i.workflow_snapshot->'steps'->(s.level-1)->>'name','permission',s.required_permission,'status',s.status) ORDER BY s.level) FROM inventory.approval_instance_steps s WHERE s.tenant_id=t AND s.instance_id=i.id),
'actions',coalesce((SELECT jsonb_agg(row_to_json(q) ORDER BY q.created_at,q.id) FROM (SELECT a.id,a.decision,a.reason,a.created_at,s.level,coalesce(a.actor_name_snapshot,u.full_name_snapshot) actor_name FROM inventory.approval_actions a JOIN inventory.approval_instance_steps s ON s.tenant_id=a.tenant_id AND s.id=a.instance_step_id JOIN inventory.tenant_memberships m ON m.tenant_id=a.tenant_id AND m.id=a.actor_id JOIN inventory.app_users u ON u.id=m.app_user_id WHERE a.tenant_id=t AND s.instance_id=i.id) q),'[]'::jsonb),
'events',coalesce((SELECT jsonb_agg(row_to_json(q) ORDER BY q.created_at,q.id) FROM (SELECT e.id,e.action,e.reason,e.created_at,u.full_name_snapshot actor_name FROM inventory.approval_events e JOIN inventory.tenant_memberships m ON m.tenant_id=e.tenant_id AND m.id=e.actor_id JOIN inventory.app_users u ON u.id=m.app_user_id WHERE e.tenant_id=t AND e.document_id=d.id ORDER BY e.created_at DESC LIMIT 200) q),'[]'::jsonb),
'files',CASE WHEN inventory_security.approval_member_allowed(actor,'files.download') THEN coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(i.payload_snapshot->'files') f WHERE f->>'sensitivity'='normal' OR inventory_security.approval_member_allowed(actor,'files.sensitive.download')),'[]'::jsonb) ELSE '[]'::jsonb END);END $$;
GRANT EXECUTE ON FUNCTION inventory_security.approval_read(uuid) TO inventory_runtime;
CREATE FUNCTION inventory_security.document_approval_trail(p_doc uuid) RETURNS TABLE(id uuid,action text,reason text,actor_id uuid,actor_name text,created_at timestamptz,revision integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;BEGIN
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND inventory.business_documents.id=p_doc;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
PERFORM inventory_security.assert_approval_actor(CASE WHEN d.supply_kind IS NULL THEN 'assets.view' ELSE 'inventory.view' END);
IF d.supply_kind IN ('request','order') THEN PERFORM inventory_security.assert_approval_actor('procurement.manage');END IF;
RETURN QUERY SELECT e.id,CASE e.action WHEN 'approved' THEN 'approve' WHEN 'rejected' THEN 'reject' WHEN 'revision_required' THEN 'revision' WHEN 'return_for_revision' THEN 'revision' ELSE e.action END,e.reason,e.actor_id,u.full_name_snapshot,e.created_at,i.document_revision FROM inventory.approval_events e LEFT JOIN inventory.approval_instances i ON i.tenant_id=e.tenant_id AND i.id=e.instance_id JOIN inventory.tenant_memberships m ON m.tenant_id=e.tenant_id AND m.id=e.actor_id JOIN inventory.app_users u ON u.id=m.app_user_id WHERE e.tenant_id=t AND e.document_id=p_doc ORDER BY e.created_at DESC LIMIT 200;END $$;
GRANT EXECUTE ON FUNCTION inventory_security.document_approval_trail(uuid) TO inventory_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_approval_actor(text),inventory_security.approval_publish(uuid,bigint,uuid,jsonb),inventory_security.approval_workflow_state(uuid,bigint,boolean,text),inventory_security.approval_submit(uuid,bigint,text),inventory_security.approval_decide(uuid,bigint,integer,text,text,uuid),inventory_security.approval_cancel(uuid,bigint,text),inventory_security.approval_return(uuid,bigint,text),inventory_security.approval_delegate(uuid,bigint,uuid,uuid,uuid,timestamptz,timestamptz,text),inventory_security.approval_directory(),inventory_security.approval_can_see(uuid),inventory_security.approval_has_workflow(uuid) TO inventory_runtime;
-- Authorization helpers used by the inbox are side-effect-free and require the caller's checked session in the service transaction.
GRANT EXECUTE ON FUNCTION inventory_security.approval_authorized(uuid,inventory.approval_instance_steps,inventory.approval_instances) TO inventory_runtime;
COMMIT;
