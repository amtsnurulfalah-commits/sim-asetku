BEGIN;
CREATE TABLE inventory.platform_provision_operations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operator_user_id uuid NOT NULL REFERENCES inventory.app_users(id),
 idempotency_key uuid NOT NULL,
 request jsonb NOT NULL,
 tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operator_user_id,idempotency_key)
);
CREATE TABLE inventory.platform_admin_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operator_user_id uuid NOT NULL REFERENCES inventory.app_users(id),
 tenant_id uuid REFERENCES inventory.tenants(id),
 action text NOT NULL CHECK(action IN ('tenant_provisioned','tenant_status_changed')),
 details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['platform_provision_operations','platform_admin_events'] LOOP
 EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY migration_owner ON inventory.%I TO %I USING(true) WITH CHECK(true)',t,current_user);
 EXECUTE format('CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite()',t);
 END LOOP;
END $$;
CREATE INDEX ON inventory.platform_admin_events(operator_user_id,created_at);
GRANT SELECT ON inventory.platform_operator_grants TO inventory_auth;
CREATE POLICY auth_own_operator_grant ON inventory.platform_operator_grants TO inventory_auth
 USING(app_user_id=inventory_security.user_id() AND can_provision AND expires_at>clock_timestamp());
-- No direct membership/settings writes by the business connection after Stage4.
REVOKE INSERT,UPDATE ON inventory.tenant_memberships,inventory.tenant_settings FROM inventory_runtime;

CREATE FUNCTION inventory_security.assert_platform(p_recent boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE u uuid:=inventory_security.user_id(); s inventory.app_sessions; BEGIN
 SELECT * INTO s FROM inventory.app_sessions WHERE token_digest=nullif(current_setting('app.session_digest',true),'') AND app_user_id=u;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.idle_expires_at<=clock_timestamp()
 OR NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active')
 OR NOT EXISTS(SELECT FROM inventory.platform_operator_grants WHERE app_user_id=u AND can_provision AND expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT FROM inventory.sso_status_cache WHERE app_user_id=u AND can_authenticate AND identity_version=s.identity_version AND valid_until>clock_timestamp()) THEN
 RAISE EXCEPTION 'Platform access denied' USING ERRCODE='42501'; END IF;
 IF p_recent AND s.authenticated_at<clock_timestamp()-interval '15 minute' THEN RAISE EXCEPTION 'Recent authentication required' USING ERRCODE='28000'; END IF;
 RETURN u; END $$;
CREATE FUNCTION inventory_security.assert_tenant_admin() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE t uuid:=inventory_security.tenant_id(); u uuid:=inventory_security.user_id(); m inventory.tenant_memberships; s inventory.app_sessions; BEGIN
 -- Serialize all tenant administrative mutations BEFORE checking the actor, avoiding
 -- two admins changing each other under inconsistent membership snapshots.
 PERFORM 1 FROM inventory.tenants WHERE id=t AND status IN ('setup','active') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant is not administrable' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM inventory.app_sessions WHERE token_digest=nullif(current_setting('app.session_digest',true),'') AND app_user_id=u;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.idle_expires_at<=clock_timestamp()
 OR s.active_tenant_id IS DISTINCT FROM t OR s.active_membership_id IS DISTINCT FROM nullif(current_setting('app.membership_id',true),'')::uuid THEN
 RAISE EXCEPTION 'Session context denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM inventory.tenant_memberships WHERE id=s.active_membership_id AND tenant_id=t AND app_user_id=u AND status='active';
 IF NOT FOUND OR m.authorization_version<>s.authorization_version
 OR NOT EXISTS(SELECT FROM inventory.roles WHERE id=m.role_id AND tenant_id=t AND code='admin')
 OR NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active')
 OR NOT EXISTS(SELECT FROM inventory.sso_status_cache WHERE app_user_id=u AND can_authenticate AND identity_version=s.identity_version AND valid_until>clock_timestamp()) THEN
 RAISE EXCEPTION 'Tenant admin required' USING ERRCODE='42501'; END IF;
 RETURN m.id; END $$;

CREATE FUNCTION inventory_security.provision_tenant(p_code text,p_name text,p_sso text,p_username text,p_full_name text,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE op uuid; old inventory.platform_provision_operations; t uuid; u uuid; role uuid; req jsonb; BEGIN
 op:=inventory_security.assert_platform(true);
 IF p_code !~ '^[A-Z0-9_-]{2,40}$' OR length(btrim(p_name)) NOT BETWEEN 1 AND 300 OR p_sso !~ '^[a-zA-Z0-9_.:-]{1,160}$'
 OR p_username !~ '^[a-z0-9][a-z0-9._-]{2,63}$' OR length(p_full_name) NOT BETWEEN 1 AND 40000 OR p_key IS NULL THEN
 RAISE EXCEPTION 'Invalid provisioning input' USING ERRCODE='23514'; END IF;
 req:=jsonb_build_object('code',p_code,'name',btrim(p_name),'admin_sso_id',p_sso);
 PERFORM pg_advisory_xact_lock(hashtextextended(op::text||p_key::text,0));
 SELECT * INTO old FROM inventory.platform_provision_operations WHERE operator_user_id=op AND idempotency_key=p_key;
 IF FOUND THEN IF old.request<>req THEN RAISE EXCEPTION 'Idempotency payload mismatch' USING ERRCODE='23514'; END IF; RETURN jsonb_build_object('id',old.tenant_id,'reused',true); END IF;
 INSERT INTO inventory.tenants(code,name,status) VALUES(p_code,btrim(p_name),'setup') RETURNING id INTO t;
 -- Administrative seed doesn't create central accounts, roles platform or file credentials.
 PERFORM inventory_security.seed_tenant(t);
 INSERT INTO inventory.app_users(sso_user_id,username_snapshot,full_name_snapshot) VALUES(p_sso,p_username,p_full_name)
 ON CONFLICT(sso_user_id) DO UPDATE SET username_snapshot=EXCLUDED.username_snapshot,full_name_snapshot=EXCLUDED.full_name_snapshot
 RETURNING id INTO u;
 IF NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active') THEN RAISE EXCEPTION 'Local user inactive' USING ERRCODE='23514'; END IF;
 SELECT id INTO role FROM inventory.roles WHERE tenant_id=t AND code='admin';
 INSERT INTO inventory.tenant_memberships(tenant_id,app_user_id,role_id) VALUES(t,u,role);
 INSERT INTO inventory.platform_provision_operations(operator_user_id,idempotency_key,request,tenant_id) VALUES(op,p_key,req,t);
 INSERT INTO inventory.platform_admin_events(operator_user_id,tenant_id,action,details)
 VALUES(op,t,'tenant_provisioned',jsonb_build_object('initial_admin_user_id',u));
 RETURN jsonb_build_object('id',t,'reused',false); END $$;

CREATE FUNCTION inventory_security.platform_tenants(p_page integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE op uuid; data jsonb; total bigint; BEGIN
 op:=inventory_security.assert_platform(false);
 IF p_page NOT BETWEEN 1 AND 1000000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO total FROM inventory.tenants;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO data FROM (
 SELECT id,code,name,status,row_version FROM inventory.tenants ORDER BY created_at DESC,id LIMIT 20 OFFSET (p_page-1)*20) x;
 RETURN jsonb_build_object('items',data,'total',total,'page',p_page,'page_size',20); END $$;

CREATE FUNCTION inventory_security.set_tenant_status(p_tenant uuid,p_status text,p_version bigint,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE op uuid; t inventory.tenants; BEGIN
 op:=inventory_security.assert_platform(true);
 IF p_status NOT IN ('active','inactive') OR length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'Invalid status/reason' USING ERRCODE='23514'; END IF;
 SELECT * INTO t FROM inventory.tenants WHERE id=p_tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found' USING ERRCODE='P0002'; END IF;
 IF t.row_version<>p_version THEN RAISE EXCEPTION 'Stale tenant version' USING ERRCODE='40001'; END IF;
 IF p_status='active' AND (NOT EXISTS(SELECT FROM inventory.tenant_memberships m JOIN inventory.roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
 JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=t.id AND m.status='active' AND r.code='admin' AND u.status='active')
 OR NOT EXISTS(SELECT FROM inventory.tenant_drive_connections WHERE tenant_id=t.id AND status='ready' AND last_tested_at>clock_timestamp()-interval '24 hour' AND last_tested_at<=clock_timestamp()+interval '1 minute'
 AND capabilities @> '{"read_metadata":true,"list":true,"create_file":true,"create_folder":true,"cleanup":true}'::jsonb)) THEN
 RAISE EXCEPTION 'Active admin and validated Drive connection required' USING ERRCODE='23514'; END IF;
 UPDATE inventory.tenants SET status=p_status WHERE id=t.id;
 IF p_status='inactive' THEN UPDATE inventory.app_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE active_tenant_id=t.id AND revoked_at IS NULL; END IF;
 INSERT INTO inventory.platform_admin_events(operator_user_id,tenant_id,action,details) VALUES(op,t.id,'tenant_status_changed',jsonb_build_object('from',t.status,'to',p_status,'reason',p_reason));
END $$;

CREATE FUNCTION inventory_security.tenant_admin_data(p_page integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE actor uuid; t uuid:=inventory_security.tenant_id(); data jsonb; role_data jsonb; profile_data jsonb; total bigint; BEGIN
 actor:=inventory_security.assert_tenant_admin();
 IF p_page NOT BETWEEN 1 AND 1000000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO total FROM inventory.tenant_memberships WHERE tenant_id=t;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO data FROM (
 SELECT m.id,m.role_id,m.status,m.row_version,m.app_user_id,u.sso_user_id,u.username_snapshot AS username,u.full_name_snapshot AS full_name,r.code AS role_code
 FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id JOIN inventory.roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
 WHERE m.tenant_id=t ORDER BY u.full_name_snapshot,m.id LIMIT 20 OFFSET(p_page-1)*20) x;
 SELECT jsonb_agg(jsonb_build_object('id',r.id,'code',r.code,'name',r.name,'row_version',r.row_version,
 'permissions',coalesce((SELECT jsonb_agg(permission_code ORDER BY permission_code) FROM inventory.role_permissions WHERE tenant_id=t AND role_id=r.id),'[]'::jsonb))) INTO role_data
 FROM inventory.roles r WHERE r.tenant_id=t;
 SELECT jsonb_build_object('id',tt.id,'code',tt.code,'name',tt.name,'status',tt.status,'timezone',tt.timezone,'row_version',tt.row_version,'profile',coalesce(s.settings->'profile','{}'::jsonb)) INTO profile_data
 FROM inventory.tenants tt JOIN inventory.tenant_settings s ON s.tenant_id=tt.id WHERE tt.id=t;
 RETURN jsonb_build_object('items',data,'page',p_page,'total',total,'page_size',20,'roles',role_data,'tenant',profile_data,'actor_id',actor,
 'permission_catalog',(SELECT jsonb_agg(jsonb_build_object('code',code,'description',description) ORDER BY code) FROM inventory.permissions),
 'history',coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM (SELECT action,resource_id,created_at,actor_id,details FROM inventory.tenant_audit_logs WHERE tenant_id=t AND action IN ('member_added','member_changed','role_permissions_changed','profile_changed') ORDER BY created_at DESC LIMIT 30) h),'[]'::jsonb));
END $$;

CREATE FUNCTION inventory_security.add_tenant_member(p_sso text,p_username text,p_name text,p_role text,p_status text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE actor uuid; t uuid:=inventory_security.tenant_id(); u uuid; role uuid; mid uuid; BEGIN
 actor:=inventory_security.assert_tenant_admin();
 IF p_sso !~ '^[a-zA-Z0-9_.:-]{1,160}$' OR p_username !~ '^[a-z0-9][a-z0-9._-]{2,63}$' OR length(p_name) NOT BETWEEN 1 AND 40000 OR p_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'Invalid member' USING ERRCODE='23514'; END IF;
 SELECT id INTO role FROM inventory.roles WHERE tenant_id=t AND code=p_role;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown role' USING ERRCODE='23514'; END IF;
 INSERT INTO inventory.app_users(sso_user_id,username_snapshot,full_name_snapshot) VALUES(p_sso,p_username,p_name)
 ON CONFLICT(sso_user_id) DO UPDATE SET username_snapshot=EXCLUDED.username_snapshot,full_name_snapshot=EXCLUDED.full_name_snapshot RETURNING id INTO u;
 IF NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active') THEN RAISE EXCEPTION 'Local user inactive' USING ERRCODE='23514'; END IF;
 IF u=inventory_security.user_id() THEN RAISE EXCEPTION 'Self provisioning not allowed' USING ERRCODE='42501'; END IF;
 INSERT INTO inventory.tenant_memberships(tenant_id,app_user_id,role_id,status) VALUES(t,u,role,p_status) RETURNING id INTO mid;
 INSERT INTO inventory.tenant_audit_logs(tenant_id,actor_id,actor_kind,action,resource_type,resource_id,correlation_id,details)
 VALUES(t,actor,'user','member_added','tenant_memberships',mid,coalesce(nullif(current_setting('app.correlation_id',true),''),'admin'),jsonb_build_object('role',p_role,'status',p_status));
 RETURN mid; END $$;

CREATE FUNCTION inventory_security.update_tenant_member(p_member uuid,p_role text,p_status text,p_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE actor uuid; t uuid:=inventory_security.tenant_id(); old inventory.tenant_memberships; r inventory.roles; BEGIN
 actor:=inventory_security.assert_tenant_admin();
 SELECT * INTO old FROM inventory.tenant_memberships WHERE id=p_member AND tenant_id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P0002'; END IF;
 IF old.id=actor OR old.app_user_id=inventory_security.user_id() THEN RAISE EXCEPTION 'Self edit denied' USING ERRCODE='42501'; END IF;
 IF old.row_version<>p_version THEN RAISE EXCEPTION 'Stale member version' USING ERRCODE='40001'; END IF;
 IF p_status NOT IN ('active','inactive','revoked') THEN RAISE EXCEPTION 'Invalid member status' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM inventory.roles WHERE tenant_id=t AND code=p_role;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown role' USING ERRCODE='23514'; END IF;
 UPDATE inventory.tenant_memberships SET role_id=r.id,status=p_status WHERE id=old.id AND tenant_id=t;
 UPDATE inventory.app_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE app_user_id=old.app_user_id AND active_tenant_id=t AND revoked_at IS NULL;
 INSERT INTO inventory.tenant_audit_logs(tenant_id,actor_id,actor_kind,action,resource_type,resource_id,correlation_id,details)
 VALUES(t,actor,'user','member_changed','tenant_memberships',old.id,coalesce(nullif(current_setting('app.correlation_id',true),''),'admin'),jsonb_build_object('old_role_id',old.role_id,'new_role_id',r.id,'old_status',old.status,'new_status',p_status));
END $$;

CREATE FUNCTION inventory_security.update_role_permissions(p_role uuid,p_permissions text[],p_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE actor uuid; t uuid:=inventory_security.tenant_id(); r inventory.roles; old text[]; BEGIN
 actor:=inventory_security.assert_tenant_admin();
 SELECT * INTO r FROM inventory.roles WHERE tenant_id=t AND id=p_role FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Role not found' USING ERRCODE='P0002'; END IF;
 IF r.code='admin' THEN RAISE EXCEPTION 'Admin permission matrix is protected' USING ERRCODE='42501'; END IF;
 IF r.row_version<>p_version THEN RAISE EXCEPTION 'Stale role version' USING ERRCODE='40001'; END IF;
 IF p_permissions IS NULL OR cardinality(p_permissions)>100 OR EXISTS(SELECT FROM unnest(p_permissions) p WHERE p IS NULL OR p IN ('users.manage','settings.manage','approval.manage'))
 OR EXISTS(SELECT FROM unnest(p_permissions) p WHERE NOT EXISTS(SELECT FROM inventory.permissions WHERE code=p)) THEN RAISE EXCEPTION 'Permission grant denied' USING ERRCODE='42501'; END IF;
 -- Actor must hold every granted permission in the fixed administrator role matrix.
 IF EXISTS(SELECT FROM unnest(p_permissions) p WHERE NOT EXISTS(SELECT FROM inventory.role_permissions rp JOIN inventory.tenant_memberships m ON m.tenant_id=rp.tenant_id AND m.role_id=rp.role_id WHERE m.id=actor AND rp.tenant_id=t AND rp.permission_code=p)) THEN
 RAISE EXCEPTION 'Cannot grant beyond own authority' USING ERRCODE='42501'; END IF;
 SELECT array_agg(permission_code ORDER BY permission_code) INTO old FROM inventory.role_permissions WHERE tenant_id=t AND role_id=r.id;
 DELETE FROM inventory.role_permissions WHERE tenant_id=t AND role_id=r.id;
 INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code) SELECT t,r.id,p FROM (SELECT DISTINCT unnest(p_permissions) AS p) x;
 UPDATE inventory.roles SET name=name WHERE id=r.id AND tenant_id=t;
 UPDATE inventory.tenant_memberships SET authorization_version=authorization_version+1 WHERE tenant_id=t AND role_id=r.id;
 UPDATE inventory.app_sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE active_tenant_id=t AND active_membership_id IN(SELECT id FROM inventory.tenant_memberships WHERE tenant_id=t AND role_id=r.id) AND revoked_at IS NULL;
 INSERT INTO inventory.tenant_audit_logs(tenant_id,actor_id,actor_kind,action,resource_type,resource_id,correlation_id,details)
 VALUES(t,actor,'user','role_permissions_changed','roles',r.id,coalesce(nullif(current_setting('app.correlation_id',true),''),'admin'),jsonb_build_object('before',old,'after',p_permissions));
END $$;

CREATE FUNCTION inventory_security.update_tenant_profile(p_name text,p_timezone text,p_profile jsonb,p_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory,pg_temp AS $$
DECLARE actor uuid; t uuid:=inventory_security.tenant_id(); v bigint; BEGIN
 actor:=inventory_security.assert_tenant_admin();
 SELECT row_version INTO v FROM inventory.tenants WHERE id=t;
 IF v<>p_version THEN RAISE EXCEPTION 'Stale tenant profile' USING ERRCODE='40001'; END IF;
 IF length(btrim(p_name)) NOT BETWEEN 1 AND 300 OR NOT EXISTS(SELECT FROM pg_timezone_names WHERE name=p_timezone) OR jsonb_typeof(p_profile)<>'object'
 OR EXISTS(SELECT FROM jsonb_object_keys(p_profile) k WHERE k NOT IN ('npsn','nsm','address','phone','email','principal_name')) OR EXISTS(SELECT FROM jsonb_each(p_profile) e WHERE jsonb_typeof(e.value)<>'string') OR octet_length(p_profile::text)>8192 THEN RAISE EXCEPTION 'Invalid profile' USING ERRCODE='23514'; END IF;
 UPDATE inventory.tenants SET name=btrim(p_name),timezone=p_timezone WHERE id=t;
 UPDATE inventory.tenant_settings SET settings=jsonb_set(settings,'{profile}',p_profile,true) WHERE tenant_id=t;
 INSERT INTO inventory.tenant_audit_logs(tenant_id,actor_id,actor_kind,action,resource_type,resource_id,correlation_id,details)
 VALUES(t,actor,'user','profile_changed','tenants',t,coalesce(nullif(current_setting('app.correlation_id',true),''),'admin'),jsonb_build_object('fields',ARRAY(SELECT jsonb_object_keys(p_profile))));
END $$;
-- Count usable local administrators when protecting the last admin.
CREATE OR REPLACE FUNCTION inventory_security.guard_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,inventory,pg_temp AS $$ DECLARE old_admin boolean; new_admin boolean; BEGIN
 PERFORM 1 FROM inventory.tenants WHERE id=OLD.tenant_id FOR UPDATE;
 IF OLD.app_user_id=inventory_security.user_id() AND
 (NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.status IS DISTINCT FROM OLD.status) THEN
 RAISE EXCEPTION 'Self privilege/status edit is not allowed' USING ERRCODE='42501'; END IF;
 SELECT code='admin' INTO old_admin FROM inventory.roles WHERE tenant_id=OLD.tenant_id AND id=OLD.role_id;
 SELECT code='admin' INTO new_admin FROM inventory.roles WHERE tenant_id=NEW.tenant_id AND id=NEW.role_id;
 IF old_admin AND OLD.status='active' AND (NOT new_admin OR NEW.status<>'active') AND NOT EXISTS(
 SELECT 1 FROM inventory.tenant_memberships m JOIN inventory.roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
 JOIN inventory.app_users u ON u.id=m.app_user_id
 WHERE u.status='active' AND m.tenant_id=OLD.tenant_id AND m.id<>OLD.id AND m.status='active' AND r.code='admin') THEN
 RAISE EXCEPTION 'Last active admin must be retained' USING ERRCODE='23514'; END IF;
 IF NEW.app_user_id IS DISTINCT FROM OLD.app_user_id THEN RAISE EXCEPTION 'Membership identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.status IS DISTINCT FROM OLD.status THEN
 NEW.authorization_version:=OLD.authorization_version+1; END IF;
 RETURN NEW; END $$;

-- Privileged primitives are private by default. No anonymous Data API grants.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.provision_tenant(text,text,text,text,text,uuid),inventory_security.platform_tenants(integer),inventory_security.set_tenant_status(uuid,text,bigint,text) TO inventory_auth;
GRANT EXECUTE ON FUNCTION inventory_security.tenant_admin_data(integer),inventory_security.add_tenant_member(text,text,text,text,text),inventory_security.update_tenant_member(uuid,text,text,bigint),inventory_security.update_role_permissions(uuid,text[],bigint),inventory_security.update_tenant_profile(text,text,jsonb,bigint) TO inventory_runtime;
COMMIT;
