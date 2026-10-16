BEGIN;
CREATE OR REPLACE FUNCTION inventory_security.report_assert(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission='approval.manage' THEN RETURN inventory_security.approval_admin();ELSIF p_permission='settings.manage' THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('dashboard.view','reports.view','reports.export','assets.view','inventory.view','files.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
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
REVOKE ALL ON FUNCTION inventory_security.report_assert(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.report_assert(text) TO inventory_runtime;

REVOKE INSERT,UPDATE,DELETE ON inventory.report_templates,inventory.generated_reports FROM inventory_runtime;
CREATE TABLE inventory.report_export_events (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),actor_id uuid NOT NULL,
 format text NOT NULL CHECK(format IN ('pdf','xlsx')),report_type text NOT NULL,filters jsonb NOT NULL,template_snapshot jsonb NOT NULL,
 row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 5000),sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
ALTER TABLE inventory.report_export_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.report_export_events FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_owner ON inventory.report_export_events TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY tenant_scope ON inventory.report_export_events TO inventory_runtime USING(tenant_id=inventory_security.tenant_id());
GRANT SELECT ON inventory.report_export_events TO inventory_runtime;
CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.report_export_events FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite();
CREATE INDEX ON inventory.report_export_events(tenant_id,created_at,id);
CREATE FUNCTION inventory_security.report_config(p_version bigint,p_config jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE actor uuid;t uuid:=inventory_security.tenant_id();r inventory.report_templates;BEGIN
actor:=inventory_security.assert_tenant_admin();
IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR octet_length(p_config::text)>24000 THEN RAISE EXCEPTION 'Invalid report configuration' USING ERRCODE='23514';END IF;
IF p_config->>'logoFileId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.file_attachments WHERE tenant_id=t AND id=(p_config->>'logoFileId')::uuid AND status='ready' AND sensitivity='normal' AND mime_type IN ('image/png','image/jpeg') AND file_size BETWEEN 1 AND 262144) THEN RAISE EXCEPTION 'Tenant logo must be a ready normal PNG/JPEG of at most 256 KiB' USING ERRCODE='23514';END IF;
SELECT * INTO r FROM inventory.report_templates WHERE tenant_id=t AND code='REPORTING_MAIN' FOR UPDATE;
IF FOUND THEN
 IF p_version IS NULL OR p_version<>r.row_version THEN RAISE EXCEPTION 'Stale configuration' USING ERRCODE='40001';END IF;
 UPDATE inventory.report_templates SET configuration=p_config,version=version+1 WHERE id=r.id;
ELSE
 IF p_version IS NOT NULL THEN RAISE EXCEPTION 'Stale configuration' USING ERRCODE='40001';END IF;
 INSERT INTO inventory.report_templates(tenant_id,code,name,report_type,version,configuration) VALUES(t,'REPORTING_MAIN','Format laporan tenant','reporting',1,p_config);
END IF;
INSERT INTO inventory.tenant_audit_logs(tenant_id,actor_id,actor_kind,action,resource_type,resource_id,correlation_id,details) VALUES(t,actor,'user','report_config_changed','report_templates',r.id,coalesce(nullif(current_setting('app.correlation_id',true),''),gen_random_uuid()::text),jsonb_build_object('configuration',p_config));
END $$;
CREATE FUNCTION inventory_security.report_record_export(p_id uuid,p_format text,p_type text,p_filters jsonb,p_template jsonb,p_count integer,p_hash text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE actor uuid;BEGIN actor:=inventory_security.report_assert('reports.export');PERFORM inventory_security.report_assert('reports.view');
IF octet_length(p_filters::text)>12000 OR octet_length(p_template::text)>24000 THEN RAISE EXCEPTION 'Export metadata too large' USING ERRCODE='23514';END IF;
INSERT INTO inventory.report_export_events(id,tenant_id,actor_id,format,report_type,filters,template_snapshot,row_count,sha256) VALUES(p_id,inventory_security.tenant_id(),actor,p_format,p_type,p_filters,p_template,p_count,p_hash);END $$;
REVOKE ALL ON FUNCTION inventory_security.report_config(bigint,jsonb),inventory_security.report_record_export(uuid,text,text,jsonb,jsonb,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.report_config(bigint,jsonb),inventory_security.report_record_export(uuid,text,text,jsonb,jsonb,integer,text) TO inventory_runtime;
COMMIT;
