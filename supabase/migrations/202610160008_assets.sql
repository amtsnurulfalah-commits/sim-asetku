BEGIN;
ALTER TABLE inventory.tenant_settings ADD COLUMN inventory_code_format text NOT NULL DEFAULT '{tenant}/{category}/{year}/{number}';
ALTER TABLE inventory.tenant_settings ADD COLUMN label_width_mm numeric NOT NULL DEFAULT 70 CHECK(label_width_mm BETWEEN 50 AND 100);
ALTER TABLE inventory.tenant_settings ADD COLUMN label_height_mm numeric NOT NULL DEFAULT 35 CHECK(label_height_mm BETWEEN 30 AND 60);
ALTER TABLE inventory.asset_building_details ADD COLUMN building_type text;
CREATE TABLE inventory.asset_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),
 name text NOT NULL,asset_count integer NOT NULL CHECK(asset_count BETWEEN 1 AND 50),created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
ALTER TABLE inventory.asset_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.asset_batches FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY migration_owner ON inventory.asset_batches TO %I USING(true) WITH CHECK(true)',current_user); END $$;
CREATE POLICY tenant_scope ON inventory.asset_batches TO inventory_runtime USING(tenant_id=inventory_security.tenant_id());
GRANT SELECT ON inventory.asset_batches TO inventory_runtime;
CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.asset_batches FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite();
CREATE TRIGGER audit_change AFTER INSERT ON inventory.asset_batches FOR EACH ROW EXECUTE FUNCTION inventory_security.audit_change();
CREATE INDEX ON inventory.asset_batches(tenant_id,created_at,id);
ALTER TABLE inventory.assets ADD COLUMN batch_id uuid;
ALTER TABLE inventory.assets ADD FOREIGN KEY(tenant_id,batch_id) REFERENCES inventory.asset_batches(tenant_id,id);
CREATE INDEX ON inventory.assets(tenant_id,batch_id);
CREATE INDEX ON inventory.assets(tenant_id,lifecycle_status,acquisition_date,id);
CREATE INDEX ON inventory.assets(tenant_id,lower(name));
-- Every mutation checks the current local session again within its transaction.
CREATE FUNCTION inventory_security.assert_asset_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission='settings.manage' THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('assets.view','assets.create','assets.update','assets.delete','assets.export','files.upload','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
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
REVOKE ALL ON FUNCTION inventory_security.assert_asset_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_asset_actor(text) TO inventory_runtime;
CREATE FUNCTION inventory_security.asset_configuration(p_format text,p_width numeric,p_height numeric) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$ BEGIN
PERFORM inventory_security.assert_tenant_admin();
IF length(p_format) NOT BETWEEN 1 AND 160 OR position('{number}' in p_format)=0 OR regexp_replace(p_format,'\{(tenant|category|year|number)\}','','g') ~ '[^A-Za-z0-9_./-]' THEN RAISE EXCEPTION 'Invalid numbering format' USING ERRCODE='23514'; END IF;
UPDATE inventory.tenant_settings SET inventory_code_format=p_format,label_width_mm=p_width,label_height_mm=p_height WHERE tenant_id=inventory_security.tenant_id();
END $$;
REVOKE ALL ON FUNCTION inventory_security.asset_configuration(text,numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.asset_configuration(text,numeric,numeric) TO inventory_runtime;
CREATE FUNCTION inventory_security.save_asset_master(p_kind text,p_id uuid,p_version bigint,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id(); tab text;cols text[];col text;names text:='';sel text:='';updates text:='';result uuid;
BEGIN
PERFORM inventory_security.assert_tenant_admin();
tab:=CASE p_kind WHEN 'categories' THEN 'asset_categories' WHEN 'subcategories' THEN 'asset_subcategories' WHEN 'units' THEN 'units' WHEN 'conditions' THEN 'asset_conditions' WHEN 'funding' THEN 'funding_sources' WHEN 'buildings' THEN 'buildings' WHEN 'rooms' THEN 'rooms' WHEN 'policies' THEN 'depreciation_policies' END;
IF tab IS NULL THEN RAISE EXCEPTION 'Unknown master' USING ERRCODE='23514'; END IF;
cols:=ARRAY['code','name','status']||CASE p_kind WHEN 'categories' THEN ARRAY['asset_kind','depreciable'] WHEN 'subcategories' THEN ARRAY['category_id'] WHEN 'conditions' THEN ARRAY['loan_allowed'] WHEN 'buildings' THEN ARRAY['address'] WHEN 'rooms' THEN ARRAY['building_id','floor_number','responsible_membership_id'] WHEN 'policies' THEN ARRAY['method','version','useful_life_months','proration'] ELSE ARRAY[]::text[] END;
IF p_kind='categories' AND p_data->>'asset_kind'='land' AND (p_data->>'depreciable')::boolean THEN RAISE EXCEPTION 'Land is nondepreciable in this policy' USING ERRCODE='23514'; END IF;
IF p_kind='categories' AND p_id IS NOT NULL AND EXISTS(SELECT FROM inventory.assets WHERE tenant_id=t AND category_id=p_id) AND EXISTS(SELECT FROM inventory.asset_categories WHERE tenant_id=t AND id=p_id AND depreciable IS DISTINCT FROM (p_data->>'depreciable')::boolean) THEN RAISE EXCEPTION 'Used category depreciation classification immutable' USING ERRCODE='23514'; END IF;
IF p_kind='subcategories' AND p_data->>'status'='active' AND NOT EXISTS(SELECT FROM inventory.asset_categories WHERE tenant_id=t AND id=(p_data->>'category_id')::uuid AND status='active') THEN RAISE EXCEPTION 'Inactive parent category' USING ERRCODE='23514'; END IF;
IF p_kind='rooms' AND p_data->>'status'='active' AND (NOT EXISTS(SELECT FROM inventory.buildings WHERE tenant_id=t AND id=(p_data->>'building_id')::uuid AND status='active') OR p_data->>'responsible_membership_id' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.tenant_memberships WHERE tenant_id=t AND id=(p_data->>'responsible_membership_id')::uuid AND status='active')) THEN RAISE EXCEPTION 'Inactive room reference' USING ERRCODE='23514'; END IF;
IF p_kind='policies' AND p_id IS NOT NULL AND EXISTS(SELECT FROM inventory.assets WHERE tenant_id=t AND depreciation_policy_id=p_id) AND EXISTS(SELECT FROM inventory.depreciation_policies p WHERE p.id=p_id AND p.tenant_id=t AND (p.method IS DISTINCT FROM p_data->>'method' OR p.version IS DISTINCT FROM (p_data->>'version')::int OR p.useful_life_months IS DISTINCT FROM (p_data->>'useful_life_months')::int OR p.proration IS DISTINCT FROM p_data->>'proration')) THEN RAISE EXCEPTION 'Used depreciation policy immutable; create new version' USING ERRCODE='23514'; END IF;
FOREACH col IN ARRAY cols LOOP
 names:=names||format(',%I',col);sel:=sel||format(',r.%I',col);updates:=updates||CASE WHEN updates='' THEN '' ELSE ',' END||format('%I=r.%I',col,col);
END LOOP;
IF p_id IS NULL THEN
 EXECUTE format('INSERT INTO inventory.%I(tenant_id%s) SELECT $1%s FROM jsonb_populate_record(NULL::inventory.%I,$2) r RETURNING id',tab,names,sel,tab) INTO result USING t,p_data;
ELSE
 EXECUTE format('UPDATE inventory.%I a SET %s FROM jsonb_populate_record(NULL::inventory.%I,$1) r WHERE a.tenant_id=$2 AND a.id=$3 AND a.row_version=$4 RETURNING a.id',tab,updates,tab) INTO result USING p_data,t,p_id,p_version;
 IF result IS NULL THEN RAISE EXCEPTION 'Not found or stale version' USING ERRCODE='40001'; END IF;
END IF;RETURN result;END $$;
REVOKE ALL ON FUNCTION inventory_security.save_asset_master(text,uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.save_asset_master(text,uuid,bigint,jsonb) TO inventory_runtime;
-- Validate newly selected references, while retaining archived historical references on unrelated edits.
CREATE FUNCTION inventory_security.asset_active_refs() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,inventory AS $$
DECLARE k text;tab text;v text;oldv text;BEGIN
FOREACH k IN ARRAY ARRAY['category_id','subcategory_id','unit_id','funding_source_id','room_id','condition_id','responsible_membership_id','depreciation_policy_id'] LOOP
v:=to_jsonb(NEW)->>k;oldv:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>k ELSE NULL END;
IF v IS NOT NULL AND (TG_OP='INSERT' OR v IS DISTINCT FROM oldv) THEN
 tab:=CASE k WHEN 'category_id' THEN 'asset_categories' WHEN 'subcategory_id' THEN 'asset_subcategories' WHEN 'unit_id' THEN 'units' WHEN 'funding_source_id' THEN 'funding_sources' WHEN 'room_id' THEN 'rooms' WHEN 'condition_id' THEN 'asset_conditions' WHEN 'responsible_membership_id' THEN 'tenant_memberships' ELSE 'depreciation_policies' END;
 EXECUTE format('SELECT id::text FROM inventory.%I WHERE tenant_id=$1 AND id=$2 AND status=''active''',tab) INTO oldv USING NEW.tenant_id,v::uuid;
 IF oldv IS NULL THEN RAISE EXCEPTION 'Reference inactive or inaccessible: %',k USING ERRCODE='23514'; END IF;
END IF;END LOOP;
IF NEW.in_service_date<NEW.acquisition_date OR NEW.acquisition_date>(SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM inventory.tenants WHERE id=NEW.tenant_id) THEN RAISE EXCEPTION 'Acquisition/service date invalid' USING ERRCODE='23514'; END IF;
RETURN NEW;END $$;
CREATE TRIGGER asset_active_refs BEFORE INSERT OR UPDATE ON inventory.assets FOR EACH ROW EXECUTE FUNCTION inventory_security.asset_active_refs();
CREATE FUNCTION inventory_security.save_asset(p_id uuid,p_version bigint,p_data jsonb,p_count integer,p_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;old inventory.assets;cat inventory.asset_categories;req text;existing inventory.idempotency_records;batch uuid;aid uuid;ids uuid[]:='{}';i int;fmt text;tenant_code text;code text;seq bigint;d jsonb:=p_data->'detail'->'data';tab text;cols text[];col text;names text:='';sel text:='';updates text:='';total_dep numeric;base_names text;base_sel text;base_updates text;
BEGIN
actor:=inventory_security.assert_asset_actor(CASE WHEN p_id IS NULL THEN 'assets.create' ELSE 'assets.update' END);
IF p_count NOT BETWEEN 1 AND 50 OR p_key IS NULL AND p_id IS NULL OR length(btrim(p_data->>'name')) NOT BETWEEN 1 AND 180 OR p_data->>'lifecycle_status' NOT IN ('draft','available') THEN RAISE EXCEPTION 'Invalid asset' USING ERRCODE='23514'; END IF;
SELECT * INTO cat FROM inventory.asset_categories WHERE tenant_id=t AND id=(p_data->>'category_id')::uuid;
IF NOT FOUND OR cat.asset_kind='inventory' THEN RAISE EXCEPTION 'Not a fixed asset category' USING ERRCODE='23514'; END IF;
IF cat.asset_kind IN ('land','building','vehicle') AND p_data->'detail'->>'type' IS DISTINCT FROM cat.asset_kind OR cat.asset_kind NOT IN ('land','building','vehicle') AND p_data->'detail'->>'type'<>'general' THEN RAISE EXCEPTION 'Typed detail required' USING ERRCODE='23514'; END IF;
IF (NOT cat.depreciable OR cat.asset_kind='land' OR cat.asset_kind='building' AND d->>'construction_status'='in_progress') AND (p_data->>'depreciation_policy_id' IS NOT NULL OR p_data->>'useful_life_months' IS NOT NULL) THEN RAISE EXCEPTION 'Nondepreciable asset policy' USING ERRCODE='23514'; END IF;
IF cat.asset_kind='building' AND d->>'construction_status'='in_progress' AND p_data->>'in_service_date' IS NOT NULL THEN RAISE EXCEPTION 'Construction in progress not yet in service' USING ERRCODE='23514'; END IF;
IF cat.asset_kind='building' AND d->>'location_building_id' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.buildings WHERE tenant_id=t AND id=(d->>'location_building_id')::uuid AND status='active') AND NOT EXISTS(SELECT FROM inventory.asset_building_details WHERE tenant_id=t AND asset_id=p_id AND location_building_id=(d->>'location_building_id')::uuid) THEN RAISE EXCEPTION 'Inactive building reference' USING ERRCODE='23514'; END IF;
IF p_data->>'depreciation_policy_id' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.depreciation_policies WHERE tenant_id=t AND id=(p_data->>'depreciation_policy_id')::uuid AND useful_life_months=(p_data->>'useful_life_months')::integer) THEN RAISE EXCEPTION 'Policy life mismatch' USING ERRCODE='23514'; END IF;
IF p_id IS NULL THEN
 req:=encode(sha256(convert_to(p_data::text||p_count::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||p_key::text,0));
 SELECT * INTO existing FROM inventory.idempotency_records WHERE tenant_id=t AND operation='asset.create' AND idempotency_key=p_key::text;
 IF FOUND THEN IF existing.request_digest<>req THEN RAISE EXCEPTION 'Idempotency mismatch' USING ERRCODE='23514'; END IF;RETURN jsonb_build_object('batchId',existing.resource_id,'ids',(SELECT jsonb_agg(id ORDER BY inventory_code) FROM inventory.assets WHERE tenant_id=t AND batch_id=existing.resource_id),'reused',true);END IF;
 IF p_count>1 AND coalesce(p_data->>'serial_number','')<>'' THEN RAISE EXCEPTION 'Serial per unit required' USING ERRCODE='23514'; END IF;
 INSERT INTO inventory.asset_batches(tenant_id,name,asset_count,created_by) VALUES(t,p_data->>'name',p_count,actor) RETURNING id INTO batch;
 SELECT inventory_code_format INTO fmt FROM inventory.tenant_settings WHERE tenant_id=t;SELECT c.code INTO tenant_code FROM inventory.tenants c WHERE id=t;
ELSE
 SELECT * INTO old FROM inventory.assets WHERE tenant_id=t AND id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF old.row_version<>p_version THEN RAISE EXCEPTION 'Stale version' USING ERRCODE='40001'; END IF;
 IF old.lifecycle_status NOT IN ('draft','available') OR old.lifecycle_status='available' AND p_data->>'lifecycle_status'<>'available' THEN RAISE EXCEPTION 'Use business lifecycle workflow' USING ERRCODE='23514'; END IF;
 IF old.lifecycle_status<>'draft' AND (old.room_id IS DISTINCT FROM (p_data->>'room_id')::uuid OR old.responsible_membership_id IS DISTINCT FROM (p_data->>'responsible_membership_id')::uuid) THEN RAISE EXCEPTION 'Use movement workflow' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(amount),0) INTO total_dep FROM inventory.depreciation_entries WHERE tenant_id=t AND asset_id=old.id;
 IF total_dep<>0 AND (old.acquisition_date IS DISTINCT FROM (p_data->>'acquisition_date')::date OR old.category_id IS DISTINCT FROM (p_data->>'category_id')::uuid OR old.acquisition_cost IS DISTINCT FROM (p_data->>'acquisition_cost')::numeric OR old.residual_value IS DISTINCT FROM (p_data->>'residual_value')::numeric OR old.depreciation_policy_id IS DISTINCT FROM (p_data->>'depreciation_policy_id')::uuid OR old.useful_life_months IS DISTINCT FROM (p_data->>'useful_life_months')::int OR old.in_service_date IS DISTINCT FROM (p_data->>'in_service_date')::date) THEN RAISE EXCEPTION 'Posted accounting data immutable' USING ERRCODE='23514'; END IF;
 p_count:=1;batch:=old.batch_id;
END IF;
cols:=ARRAY['name','category_id','subcategory_id','unit_id','funding_source_id','room_id','responsible_membership_id','condition_id','lifecycle_status','brand','model','serial_number','specifications','acquisition_date','in_service_date','acquisition_method','acquisition_cost','residual_value','useful_life_months','depreciation_policy_id','notes'];
FOREACH col IN ARRAY cols LOOP names:=names||format(',%I',col);sel:=sel||format(',r.%I',col);updates:=updates||CASE WHEN updates='' THEN '' ELSE ',' END||format('%I=r.%I',col,col);END LOOP;
base_names:=names;base_sel:=sel;base_updates:=updates;
FOR i IN 1..p_count LOOP
 IF p_id IS NULL THEN
  seq:=inventory_security.next_number('asset',0);code:=replace(replace(replace(replace(fmt,'{tenant}',tenant_code),'{category}',cat.code),'{year}',extract(year from (p_data->>'acquisition_date')::date)::text),'{number}',lpad(seq::text,greatest(6,length(seq::text)),'0'));
  EXECUTE format('INSERT INTO inventory.assets(tenant_id,inventory_code,batch_id%s) SELECT $1,$2,$3%s FROM jsonb_populate_record(NULL::inventory.assets,$4) r RETURNING id',base_names,base_sel) INTO aid USING t,code,batch,p_data;
 ELSE
  aid:=p_id;EXECUTE format('UPDATE inventory.assets a SET %s FROM jsonb_populate_record(NULL::inventory.assets,$1) r WHERE a.id=$2 AND a.tenant_id=$3',base_updates) USING p_data,aid,t;
 END IF;
 IF p_id IS NULL OR old.room_id IS DISTINCT FROM (p_data->>'room_id')::uuid THEN INSERT INTO inventory.asset_location_history(tenant_id,asset_id,from_room_id,to_room_id,actor_id,reason) VALUES(t,aid,old.room_id,(p_data->>'room_id')::uuid,actor,p_data->>'reason');END IF;
 IF p_id IS NULL OR old.condition_id IS DISTINCT FROM (p_data->>'condition_id')::uuid THEN INSERT INTO inventory.asset_condition_history(tenant_id,asset_id,from_condition_id,to_condition_id,actor_id,reason) VALUES(t,aid,old.condition_id,(p_data->>'condition_id')::uuid,actor,p_data->>'reason');END IF;
 tab:=CASE cat.asset_kind WHEN 'land' THEN 'asset_land_details' WHEN 'building' THEN 'asset_building_details' WHEN 'vehicle' THEN 'asset_vehicle_details' END;
 IF tab IS NOT NULL THEN
 cols:=CASE cat.asset_kind WHEN 'land' THEN ARRAY['area_sqm','address','ownership_status','certificate_number','rights_type','land_use'] WHEN 'building' THEN ARRAY['location_building_id','building_type','construction_year','area_sqm','floor_count','construction_status','ownership_status'] ELSE ARRAY['vehicle_type','manufacturing_year','registration_number','chassis_number','engine_number','ownership_document_number','registration_expiry','next_service_date'] END;
 names:='';sel:='';updates:='';FOREACH col IN ARRAY cols LOOP names:=names||format(',%I',col);sel:=sel||format(',r.%I',col);updates:=updates||CASE WHEN updates='' THEN '' ELSE ',' END||format('%I=excluded.%I',col,col);END LOOP;
 EXECUTE format('INSERT INTO inventory.%I(tenant_id,asset_id%s) SELECT $1,$2%s FROM jsonb_populate_record(NULL::inventory.%I,$3) r ON CONFLICT(tenant_id,asset_id) DO UPDATE SET %s',tab,names,sel,tab,updates) USING t,aid,d;
 END IF;
 ids:=array_append(ids,aid);
END LOOP;
IF p_id IS NULL THEN INSERT INTO inventory.idempotency_records(tenant_id,operation,idempotency_key,request_digest,resource_id,expires_at) VALUES(t,'asset.create',p_key::text,req,batch,clock_timestamp()+interval '10 years');END IF;
RETURN jsonb_build_object('batchId',batch,'ids',to_jsonb(ids),'reused',false);
END $$;
REVOKE ALL ON FUNCTION inventory_security.save_asset(uuid,bigint,jsonb,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.save_asset(uuid,bigint,jsonb,integer,uuid) TO inventory_runtime;
CREATE FUNCTION inventory_security.archive_asset(p_id uuid,p_version bigint,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE a inventory.assets;BEGIN
PERFORM inventory_security.assert_asset_actor('assets.delete');SELECT * INTO a FROM inventory.assets WHERE tenant_id=inventory_security.tenant_id() AND id=p_id FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
IF a.row_version<>p_version THEN RAISE EXCEPTION 'Stale version' USING ERRCODE='40001';END IF;
IF a.lifecycle_status NOT IN ('draft','available') OR EXISTS(SELECT FROM inventory.asset_reservations WHERE tenant_id=a.tenant_id AND asset_id=a.id AND released_at IS NULL) OR length(btrim(p_reason))<3 THEN RAISE EXCEPTION 'Active transaction or invalid archive reason' USING ERRCODE='23514';END IF;
UPDATE inventory.assets SET lifecycle_status='archived',notes=coalesce(notes,'')||E'\nArsip: '||p_reason WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION inventory_security.archive_asset(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.archive_asset(uuid,bigint,text) TO inventory_runtime;
CREATE FUNCTION inventory_security.link_asset_file(p_asset uuid,p_file uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();result uuid;BEGIN
PERFORM inventory_security.assert_asset_actor('assets.update');PERFORM inventory_security.assert_asset_actor('files.upload');
IF NOT EXISTS(SELECT FROM inventory.assets WHERE tenant_id=t AND id=p_asset AND lifecycle_status IN ('draft','available')) OR NOT EXISTS(SELECT FROM inventory.file_attachments WHERE tenant_id=t AND id=p_file AND status='ready') THEN RAISE EXCEPTION 'Inaccessible asset/file' USING ERRCODE='23514';END IF;
INSERT INTO inventory.asset_attachments(tenant_id,asset_id,file_id) VALUES(t,p_asset,p_file) ON CONFLICT(tenant_id,asset_id,file_id) DO UPDATE SET file_id=excluded.file_id RETURNING id INTO result;RETURN result;END $$;
REVOKE ALL ON FUNCTION inventory_security.link_asset_file(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.link_asset_file(uuid,uuid) TO inventory_runtime;
REVOKE INSERT,UPDATE ON inventory.idempotency_records,inventory.numbering_sequences,inventory.assets,inventory.asset_land_details,inventory.asset_building_details,inventory.asset_vehicle_details,inventory.asset_categories,inventory.asset_subcategories,inventory.units,inventory.asset_conditions,inventory.funding_sources,inventory.buildings,inventory.rooms,inventory.depreciation_policies,inventory.asset_location_history,inventory.asset_condition_history,inventory.asset_attachments FROM inventory_runtime;
CREATE FUNCTION inventory_security.asset_member_options(p_permission text) RETURNS TABLE(id uuid,name text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$ BEGIN
IF p_permission NOT IN ('assets.view','settings.manage') THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501'; END IF;
PERFORM inventory_security.assert_asset_actor(p_permission);
RETURN QUERY SELECT m.id,u.full_name_snapshot FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=inventory_security.tenant_id() AND m.status='active' AND u.status='active' ORDER BY u.full_name_snapshot LIMIT 1000;
END $$;
REVOKE ALL ON FUNCTION inventory_security.asset_member_options(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.asset_member_options(text) TO inventory_runtime;
-- Existing reservation triggers retain their narrow state transition after broad asset DML is revoked.
ALTER FUNCTION inventory_security.reserve_asset() SECURITY DEFINER;
ALTER FUNCTION inventory_security.sync_reservation_state() SECURITY DEFINER;
REVOKE ALL ON FUNCTION inventory_security.asset_active_refs() FROM PUBLIC;
COMMIT;
