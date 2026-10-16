-- Administrative one-time provisioning AFTER migrations. Not a runtime query.
-- Run on the confirmed Supabase test target first. This does not set passwords.
-- If either name already exists, stop and inspect its attributes and memberships.
BEGIN;
CREATE ROLE inventory_web_auth LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inventory_web_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT inventory_auth TO inventory_web_auth;
GRANT inventory_runtime TO inventory_web_runtime;
GRANT CONNECT ON DATABASE postgres TO inventory_web_auth,inventory_web_runtime;
COMMIT;
-- In an interactive trusted psql session, set each password with:
-- \password inventory_web_auth
-- \password inventory_web_runtime
-- Never use the migration owner or service_role as an application connection.
