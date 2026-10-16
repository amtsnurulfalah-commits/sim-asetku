BEGIN;
ALTER TABLE inventory.tenant_drive_connections ADD COLUMN last_error_code text;
ALTER TABLE inventory.tenant_drive_connections ADD COLUMN root_folder_name text;
ALTER TABLE inventory.tenant_drive_connections ADD COLUMN operation_lease_until timestamptz;
ALTER TABLE inventory.file_upload_operations ADD COLUMN first_chunk_verified boolean NOT NULL DEFAULT false;
CREATE TABLE inventory.drive_oauth_states (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),
 actor_id uuid NOT NULL, session_digest text NOT NULL, state_digest text NOT NULL UNIQUE,
 root_folder_id text NOT NULL, verifier_ciphertext text NOT NULL, encryption_key_id text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
ALTER TABLE inventory.drive_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.drive_oauth_states FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY migration_owner ON inventory.drive_oauth_states TO %I USING(true) WITH CHECK(true)',current_user); END $$;
CREATE POLICY tenant_scope ON inventory.drive_oauth_states TO inventory_runtime
 USING(tenant_id=inventory_security.tenant_id() AND actor_id=nullif(current_setting('app.membership_id',true),'')::uuid AND session_digest=nullif(current_setting('app.session_digest',true),''))
 WITH CHECK(tenant_id=inventory_security.tenant_id() AND actor_id=nullif(current_setting('app.membership_id',true),'')::uuid AND session_digest=nullif(current_setting('app.session_digest',true),''));
GRANT SELECT,INSERT,UPDATE ON inventory.drive_oauth_states TO inventory_runtime;
CREATE INDEX ON inventory.drive_oauth_states(tenant_id,expires_at);
-- Serialize folder initialization across requests without keeping a transaction open during Google calls.
-- Upload claims similarly use a token lease; expired claims require querying Google before a retry.
CREATE UNIQUE INDEX drive_one_pending ON inventory.tenant_drive_connections(tenant_id) WHERE status='pending';
CREATE INDEX drive_upload_recovery ON inventory.file_upload_operations(tenant_id,status,expires_at);
COMMENT ON COLUMN inventory.tenant_drive_connections.token_ciphertext IS 'AES-256-GCM ciphertext with tenant/connection AAD; never returned to browser';
COMMENT ON COLUMN inventory.file_upload_operations.resumable_uri_ciphertext IS 'Server-only encrypted Google upload URI; never returned to browser';
ALTER TABLE inventory.tenant_drive_connections ADD COLUMN root_ancestor_ids text[] NOT NULL DEFAULT '{}';
CREATE FUNCTION inventory_security.drive_admin_guard() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$ BEGIN RETURN inventory_security.assert_tenant_admin(); END $$;
REVOKE ALL ON FUNCTION inventory_security.drive_admin_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.drive_admin_guard() TO inventory_runtime;
CREATE FUNCTION inventory_security.claim_drive_root(p_id uuid,p_ancestors text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$ DECLARE c inventory.tenant_drive_connections; BEGIN
PERFORM inventory_security.assert_tenant_admin();
PERFORM pg_advisory_xact_lock(74268195);
SELECT * INTO STRICT c FROM inventory.tenant_drive_connections WHERE id=p_id AND tenant_id=inventory_security.tenant_id();
IF EXISTS(SELECT 1 FROM inventory.tenant_drive_connections d WHERE d.tenant_id<>c.tenant_id AND
(d.root_folder_id=c.root_folder_id OR d.root_folder_id=ANY(p_ancestors) OR c.root_folder_id=ANY(d.root_ancestor_ids))) THEN
RAISE EXCEPTION 'Root already reserved or overlaps' USING ERRCODE='23505'; END IF;
UPDATE inventory.tenant_drive_connections SET root_ancestor_ids=p_ancestors WHERE id=c.id;
END $$;
REVOKE ALL ON FUNCTION inventory_security.claim_drive_root(uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.claim_drive_root(uuid,text[]) TO inventory_runtime;
CREATE FUNCTION inventory_security.assert_drive_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id(); u uuid:=inventory_security.user_id(); s inventory.app_sessions; m inventory.tenant_memberships;
BEGIN
IF p_permission='settings.manage' THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('files.upload','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Invalid drive permission' USING ERRCODE='42501'; END IF;
PERFORM 1 FROM inventory.tenants WHERE id=t AND status='active' FOR SHARE;
IF NOT FOUND THEN RAISE EXCEPTION 'Active tenant required' USING ERRCODE='42501'; END IF;
SELECT * INTO s FROM inventory.app_sessions WHERE token_digest=nullif(current_setting('app.session_digest',true),'') AND app_user_id=u;
IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.idle_expires_at<=clock_timestamp()
OR s.active_tenant_id IS DISTINCT FROM t OR s.active_membership_id IS DISTINCT FROM nullif(current_setting('app.membership_id',true),'')::uuid THEN
RAISE EXCEPTION 'Session context denied' USING ERRCODE='42501'; END IF;
SELECT * INTO m FROM inventory.tenant_memberships WHERE id=s.active_membership_id AND tenant_id=t AND app_user_id=u AND status='active';
IF NOT FOUND OR m.authorization_version<>s.authorization_version
OR NOT EXISTS(SELECT FROM inventory.app_users WHERE id=u AND status='active')
OR NOT EXISTS(SELECT FROM inventory.sso_status_cache WHERE app_user_id=u AND can_authenticate AND identity_version=s.identity_version AND valid_until>clock_timestamp())
OR NOT (EXISTS(SELECT FROM inventory.role_permissions WHERE tenant_id=t AND role_id=m.role_id AND permission_code=p_permission)
OR EXISTS(SELECT FROM inventory.membership_permission_grants WHERE tenant_id=t AND membership_id=m.id AND permission_code=p_permission AND (expires_at IS NULL OR expires_at>clock_timestamp()))) THEN
RAISE EXCEPTION 'Drive actor denied' USING ERRCODE='42501'; END IF;
RETURN m.id;
END $$;
REVOKE ALL ON FUNCTION inventory_security.assert_drive_actor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.assert_drive_actor(text) TO inventory_runtime;
COMMIT;
