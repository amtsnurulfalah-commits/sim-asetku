BEGIN;
-- Stage 3 adds auth events without changing any previously released migration.
CREATE TABLE inventory.auth_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 app_user_id uuid REFERENCES inventory.app_users(id),
 event text NOT NULL CHECK(event IN ('login','login_denied','logout','session_revoked','tenant_switch')),
 result_code text NOT NULL CHECK(result_code ~ '^[A-Z0-9_]{1,80}$'),
 correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE inventory.auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.auth_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY migration_owner ON inventory.auth_events TO %I USING(true) WITH CHECK(true)',current_user); END $$;
CREATE POLICY auth_event_insert ON inventory.auth_events FOR INSERT TO inventory_auth
 WITH CHECK(app_user_id IS NULL OR app_user_id=inventory_security.user_id());
GRANT INSERT ON inventory.auth_events TO inventory_auth;
CREATE INDEX ON inventory.auth_events(app_user_id,created_at);
CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.auth_events FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite();
-- Only display snapshots can be refreshed by authentication; no status or identity edits.
GRANT UPDATE(username_snapshot,full_name_snapshot) ON inventory.app_users TO inventory_auth;
-- Query helper indexes for expiry and recent status without polling every user.
CREATE INDEX ON inventory.app_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX ON inventory.app_sessions(idle_expires_at) WHERE revoked_at IS NULL;
CREATE INDEX ON inventory.login_rate_limits(window_started_at);
REVOKE ALL ON inventory.auth_events FROM PUBLIC;
COMMIT;
