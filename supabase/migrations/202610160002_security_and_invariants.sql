BEGIN;
-- Immutable histories are never rewritten, including by normal migration-owner DML.
CREATE FUNCTION inventory_security.reject_rewrite() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Append-only history: %',TG_TABLE_NAME USING ERRCODE='55000'; END $$;
CREATE FUNCTION inventory_security.touch_row() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Record ID is immutable' USING ERRCODE='23514'; END IF;
 IF to_jsonb(NEW)->>'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->>'tenant_id' THEN
 RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE='23514'; END IF;
 NEW.updated_at:=clock_timestamp(); NEW.row_version:=OLD.row_version+1; RETURN NEW;
END $$;
-- All tenant-owned records require a nonempty tenant context for runtime reads/writes.
DO $$ DECLARE r record; owner_name text:=current_user; BEGIN
 FOR r IN SELECT c.relname, EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped) AS tenant_owned,
 EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='row_version' AND NOT a.attisdropped) AS mutable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='inventory' AND c.relkind='r'
 LOOP
 EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY',r.relname);
 EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY',r.relname);
 EXECUTE format('CREATE POLICY migration_owner ON inventory.%I TO %I USING (true) WITH CHECK (true)',r.relname,owner_name);
 IF r.tenant_owned THEN
 EXECUTE format('CREATE POLICY tenant_scope ON inventory.%I TO inventory_runtime USING (tenant_id=inventory_security.tenant_id()) WITH CHECK (tenant_id=inventory_security.tenant_id())',r.relname);
 EXECUTE format('GRANT SELECT,INSERT ON inventory.%I TO inventory_runtime',r.relname);
 IF r.mutable THEN EXECUTE format('GRANT UPDATE ON inventory.%I TO inventory_runtime',r.relname); END IF;
 END IF;
 IF r.mutable THEN
 EXECUTE format('CREATE TRIGGER touch_row BEFORE UPDATE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.touch_row()',r.relname);
 ELSE
 EXECUTE format('CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite()',r.relname);
 END IF;
 END LOOP;
END $$;
-- No runtime DDL, TRUNCATE, DELETE, role membership, or writes to global identity/catalog.
GRANT SELECT ON inventory.tenants,inventory.permissions TO inventory_runtime;
CREATE POLICY tenant_self ON inventory.tenants TO inventory_runtime
 USING(id=inventory_security.tenant_id());
CREATE POLICY permission_catalog ON inventory.permissions TO inventory_runtime,inventory_auth USING(true);
GRANT SELECT ON inventory.permissions TO inventory_auth;
-- Separate server-only authentication connection; no access to assets, files or financial data.
GRANT SELECT ON inventory.app_users,inventory.tenant_memberships,inventory.tenants TO inventory_auth;
GRANT SELECT,INSERT,UPDATE ON inventory.app_sessions,inventory.login_rate_limits,inventory.sso_status_cache TO inventory_auth;
CREATE POLICY auth_identity ON inventory.app_users TO inventory_auth
 USING(id=inventory_security.user_id() OR sso_user_id=nullif(current_setting('app.sso_user_id',true),''));
CREATE POLICY auth_memberships ON inventory.tenant_memberships TO inventory_auth
 USING(app_user_id=inventory_security.user_id());
CREATE POLICY auth_tenants ON inventory.tenants TO inventory_auth
 USING(EXISTS(SELECT 1 FROM inventory.tenant_memberships m WHERE m.tenant_id=inventory.tenants.id AND m.app_user_id=inventory_security.user_id() AND m.status='active'));
CREATE POLICY auth_session ON inventory.app_sessions TO inventory_auth
 USING(app_user_id=inventory_security.user_id() OR token_digest=nullif(current_setting('app.session_digest',true),''))
 WITH CHECK(app_user_id=inventory_security.user_id());
CREATE POLICY auth_status ON inventory.sso_status_cache TO inventory_auth
 USING(app_user_id=inventory_security.user_id()) WITH CHECK(app_user_id=inventory_security.user_id());
CREATE POLICY auth_rate_limit ON inventory.login_rate_limits TO inventory_auth
 USING(key_digest=nullif(current_setting('app.rate_limit_digest',true),''))
 WITH CHECK(key_digest=nullif(current_setting('app.rate_limit_digest',true),''));

-- Only the ledger trigger may change derived stock balances.
REVOKE INSERT,UPDATE ON inventory.inventory_stock_balances FROM inventory_runtime;
CREATE FUNCTION inventory_security.apply_stock_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,inventory AS $$
BEGIN
 INSERT INTO inventory.inventory_stock_balances(tenant_id,item_id,room_id,quantity,stock_value)
 VALUES(NEW.tenant_id,NEW.item_id,NEW.room_id,0,0)
 ON CONFLICT(tenant_id,item_id,room_id) DO NOTHING;
 UPDATE inventory.inventory_stock_balances
 SET quantity=quantity+NEW.quantity_delta, stock_value=stock_value+NEW.value_delta
 WHERE tenant_id=NEW.tenant_id AND item_id=NEW.item_id AND room_id=NEW.room_id;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_entry AFTER INSERT ON inventory.inventory_stock_ledger
 FOR EACH ROW EXECUTE FUNCTION inventory_security.apply_stock_entry();
-- Stronger typed relationships within each tenant.
ALTER TABLE inventory.asset_returns ADD UNIQUE(tenant_id,id,loan_id);
ALTER TABLE inventory.asset_loan_items ADD UNIQUE(tenant_id,id,loan_id);
ALTER TABLE inventory.asset_return_items ADD COLUMN loan_id uuid NOT NULL;
ALTER TABLE inventory.asset_return_items ADD FOREIGN KEY(tenant_id,return_id,loan_id) REFERENCES inventory.asset_returns(tenant_id,id,loan_id);
ALTER TABLE inventory.asset_return_items ADD FOREIGN KEY(tenant_id,loan_item_id,loan_id) REFERENCES inventory.asset_loan_items(tenant_id,id,loan_id);
ALTER TABLE inventory.disposal_request_items ADD UNIQUE(tenant_id,id,asset_id);
ALTER TABLE inventory.asset_disposals ADD FOREIGN KEY(tenant_id,request_item_id,asset_id) REFERENCES inventory.disposal_request_items(tenant_id,id,asset_id);
ALTER TABLE inventory.stock_opname_items ADD UNIQUE(tenant_id,id,session_id);
ALTER TABLE inventory.stock_opname_findings ADD FOREIGN KEY(tenant_id,opname_item_id,session_id) REFERENCES inventory.stock_opname_items(tenant_id,id,session_id);
ALTER TABLE inventory.depreciation_runs ADD UNIQUE(tenant_id,id,period);
ALTER TABLE inventory.depreciation_entries ADD FOREIGN KEY(tenant_id,run_id,period) REFERENCES inventory.depreciation_runs(tenant_id,id,period);
ALTER TABLE inventory.depreciation_entries ADD UNIQUE(tenant_id,id,asset_id);
ALTER TABLE inventory.depreciation_entries ADD FOREIGN KEY(tenant_id,correction_of,asset_id) REFERENCES inventory.depreciation_entries(tenant_id,id,asset_id);

-- Details must match the asset category's kind.
CREATE FUNCTION inventory_security.check_asset_detail() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ DECLARE actual text; expected text; BEGIN
 expected:=CASE TG_TABLE_NAME WHEN 'asset_land_details' THEN 'land' WHEN 'asset_building_details' THEN 'building' ELSE 'vehicle' END;
 SELECT c.asset_kind INTO actual FROM inventory.assets a JOIN inventory.asset_categories c
 ON c.tenant_id=a.tenant_id AND c.id=a.category_id WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.asset_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Asset kind does not match detail' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER detail_kind BEFORE INSERT OR UPDATE ON inventory.asset_land_details FOR EACH ROW EXECUTE FUNCTION inventory_security.check_asset_detail();
CREATE TRIGGER detail_kind BEFORE INSERT OR UPDATE ON inventory.asset_building_details FOR EACH ROW EXECUTE FUNCTION inventory_security.check_asset_detail();
CREATE TRIGGER detail_kind BEFORE INSERT OR UPDATE ON inventory.asset_vehicle_details FOR EACH ROW EXECUTE FUNCTION inventory_security.check_asset_detail();
CREATE FUNCTION inventory_security.protect_asset_kind() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ BEGIN
 IF OLD.category_id IS DISTINCT FROM NEW.category_id AND (
 EXISTS(SELECT FROM inventory.asset_land_details WHERE tenant_id=OLD.tenant_id AND asset_id=OLD.id) OR
 EXISTS(SELECT FROM inventory.asset_building_details WHERE tenant_id=OLD.tenant_id AND asset_id=OLD.id) OR
 EXISTS(SELECT FROM inventory.asset_vehicle_details WHERE tenant_id=OLD.tenant_id AND asset_id=OLD.id)) THEN
 RAISE EXCEPTION 'Remove/reclassify typed details through reviewed migration before changing category' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER protect_kind BEFORE UPDATE ON inventory.assets FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_asset_kind();
CREATE FUNCTION inventory_security.protect_category_kind() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ BEGIN
 IF NEW.asset_kind<>OLD.asset_kind AND EXISTS(SELECT FROM inventory.assets WHERE tenant_id=OLD.tenant_id AND category_id=OLD.id) THEN
 RAISE EXCEPTION 'Cannot change kind of a used category' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER category_kind BEFORE UPDATE ON inventory.asset_categories FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_category_kind();

-- Membership writes serialize on tenant; prevent self privilege edits and loss of last admin.
CREATE FUNCTION inventory_security.guard_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,inventory AS $$ DECLARE old_admin boolean; new_admin boolean; BEGIN
 PERFORM 1 FROM inventory.tenants WHERE id=OLD.tenant_id FOR UPDATE;
 IF OLD.app_user_id=inventory_security.user_id() AND
 (NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.status IS DISTINCT FROM OLD.status) THEN
 RAISE EXCEPTION 'Self privilege/status edit is not allowed' USING ERRCODE='42501'; END IF;
 SELECT code='admin' INTO old_admin FROM inventory.roles WHERE tenant_id=OLD.tenant_id AND id=OLD.role_id;
 SELECT code='admin' INTO new_admin FROM inventory.roles WHERE tenant_id=NEW.tenant_id AND id=NEW.role_id;
 IF old_admin AND OLD.status='active' AND (NOT new_admin OR NEW.status<>'active') AND NOT EXISTS(
 SELECT 1 FROM inventory.tenant_memberships m JOIN inventory.roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
 WHERE m.tenant_id=OLD.tenant_id AND m.id<>OLD.id AND m.status='active' AND r.code='admin') THEN
 RAISE EXCEPTION 'Last active admin must be retained' USING ERRCODE='23514'; END IF;
 IF NEW.app_user_id IS DISTINCT FROM OLD.app_user_id THEN RAISE EXCEPTION 'Membership identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.status IS DISTINCT FROM OLD.status THEN
 NEW.authorization_version:=OLD.authorization_version+1; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER membership_guard BEFORE UPDATE ON inventory.tenant_memberships FOR EACH ROW EXECUTE FUNCTION inventory_security.guard_membership();
-- No runtime edits to the role permission matrix: use reviewed operator migration until
-- a constrained users.manage service is implemented and tested in Stage 4.
REVOKE INSERT,UPDATE ON inventory.roles,inventory.role_permissions,inventory.membership_permission_grants FROM inventory_runtime;
-- Reserve posting/approval evidence for Stage 7-10 constrained services. Schema alone
-- must not allow arbitrary runtime requests to fabricate approved financial evidence.
REVOKE INSERT,UPDATE ON inventory.asset_disposals,inventory.depreciation_entries,
 inventory.approval_actions,inventory.inventory_stock_ledger FROM inventory_runtime;
-- Posting function below is the single stock write interface (server permission guard required).
CREATE FUNCTION inventory_security.post_stock(p_item uuid,p_room uuid,p_quantity numeric,p_value numeric,
 p_kind text,p_document uuid,p_actor uuid,p_posting_key text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,inventory AS $$ DECLARE t uuid:=inventory_security.tenant_id(); result uuid; existing inventory.inventory_stock_ledger; BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Tenant context required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM inventory.tenant_memberships m JOIN inventory.tenants tt ON tt.id=m.tenant_id
 WHERE m.id=p_actor AND m.tenant_id=t AND m.app_user_id=inventory_security.user_id() AND m.status='active' AND tt.status='active') THEN
 RAISE EXCEPTION 'Active actor required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM inventory.tenant_memberships m JOIN inventory.role_permissions rp ON rp.tenant_id=m.tenant_id AND rp.role_id=m.role_id
 WHERE m.id=p_actor AND m.tenant_id=t AND rp.permission_code=CASE p_kind WHEN 'receipt' THEN 'inventory.receive' WHEN 'issue' THEN 'inventory.issue' ELSE 'inventory.adjust' END) THEN
 RAISE EXCEPTION 'Stock permission denied' USING ERRCODE='42501'; END IF;
 IF (p_kind='receipt' AND p_quantity<=0) OR (p_kind='issue' AND p_quantity>=0) OR p_kind NOT IN ('receipt','issue','adjustment') THEN
 RAISE EXCEPTION 'Stock sign/kind invalid' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM inventory.business_documents WHERE tenant_id=t AND id=p_document AND status='approved') THEN
 RAISE EXCEPTION 'Approved source document required' USING ERRCODE='23514'; END IF;
 -- Serialize retries for this operation; stock balance UPSERT serializes different postings.
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':'||p_posting_key,0));
 SELECT * INTO existing FROM inventory.inventory_stock_ledger WHERE tenant_id=t AND posting_key=p_posting_key;
 IF FOUND THEN
 IF (existing.item_id,existing.room_id,existing.quantity_delta,existing.value_delta,existing.kind,existing.source_document_id,existing.actor_id)
 IS DISTINCT FROM (p_item,p_room,p_quantity,p_value,p_kind,p_document,p_actor) THEN
 RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE='23514'; END IF;
 RETURN existing.id;
 END IF;
 INSERT INTO inventory.inventory_stock_ledger(tenant_id,item_id,room_id,quantity_delta,value_delta,kind,source_document_id,actor_id,posting_key)
 VALUES(t,p_item,p_room,p_quantity,p_value,p_kind,p_document,p_actor,p_posting_key) RETURNING id INTO result;
 RETURN result; END $$;
-- Do not expose stock posting until services enforce valuation and approval posting in later stages.
-- Tests explicitly grant this function only to a disposable test role.

-- Atomic numbering under transaction-local tenant context; no COUNT/MAX races.
CREATE FUNCTION inventory_security.next_number(p_purpose text,p_period integer) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,inventory AS $$ DECLARE t uuid:=inventory_security.tenant_id(); n bigint; BEGIN
 IF t IS NULL OR length(p_purpose) NOT BETWEEN 1 AND 100 OR p_period<0 THEN RAISE EXCEPTION 'Invalid numbering context' USING ERRCODE='23514'; END IF;
 INSERT INTO inventory.numbering_sequences(tenant_id,purpose,period,last_value) VALUES(t,p_purpose,p_period,1)
 ON CONFLICT(tenant_id,purpose,period) DO UPDATE SET last_value=numbering_sequences.last_value+1 RETURNING last_value INTO n;
 RETURN n; END $$;
REVOKE INSERT,UPDATE ON inventory.numbering_sequences,inventory.document_sequences FROM inventory_runtime;
GRANT EXECUTE ON FUNCTION inventory_security.next_number(text,integer) TO inventory_runtime;
-- Capture sanitized metadata only. No row payload, password, token or OAuth secret is logged.
CREATE FUNCTION inventory_security.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,inventory AS $$ DECLARE actor uuid; BEGIN
 actor:=nullif(current_setting('app.membership_id',true),'')::uuid;
 IF actor IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=NEW.tenant_id AND id=actor) THEN
 RAISE EXCEPTION 'Audit actor tenant mismatch' USING ERRCODE='23514'; END IF;
 INSERT INTO inventory.tenant_audit_logs(tenant_id,actor_id,actor_kind,action,resource_type,resource_id,correlation_id,details)
 VALUES(NEW.tenant_id,actor,CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,lower(TG_OP),TG_TABLE_NAME,NEW.id,
 coalesce(nullif(current_setting('app.correlation_id',true),''),'database'),jsonb_build_object('row_version',to_jsonb(NEW)->'row_version'));
 RETURN NEW; END $$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='inventory' AND c.relkind='r' AND c.relname NOT IN ('tenant_audit_logs','file_access_logs','outbox_jobs','idempotency_records')
 AND EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id')
 LOOP EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.audit_change()',r.relname); END LOOP;
END $$;
REVOKE INSERT ON inventory.tenant_audit_logs FROM inventory_runtime;
-- Lock publication and document status until later approval/posting services are installed.
REVOKE INSERT,UPDATE ON inventory.business_documents,inventory.approval_instances,inventory.approval_instance_steps,inventory.approval_workflow_versions,inventory.approval_workflow_steps FROM inventory_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
COMMIT;
