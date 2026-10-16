BEGIN;
ALTER TABLE inventory.asset_conditions ADD COLUMN loan_allowed boolean NOT NULL DEFAULT false;
UPDATE inventory.asset_conditions SET loan_allowed=true WHERE code IN ('BAIK','RUSAK_RINGAN');
-- Future tenant reference seeds also set safe loan defaults.
CREATE FUNCTION inventory_security.condition_defaults() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.code IN ('BAIK','RUSAK_RINGAN') THEN NEW.loan_allowed:=true; END IF; RETURN NEW; END $$;
CREATE TRIGGER condition_defaults BEFORE INSERT ON inventory.asset_conditions FOR EACH ROW EXECUTE FUNCTION inventory_security.condition_defaults();

CREATE FUNCTION inventory_security.reserve_asset() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ DECLARE asset_state text; allowed boolean; BEGIN
 IF TG_OP='UPDATE' THEN
 IF (NEW.asset_id,NEW.loan_item_id,NEW.reserved_by) IS DISTINCT FROM (OLD.asset_id,OLD.loan_item_id,OLD.reserved_by) THEN
 RAISE EXCEPTION 'Reservation identity is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
 RAISE EXCEPTION 'Released reservation is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
 END IF;
 SELECT a.lifecycle_status,c.loan_allowed INTO asset_state,allowed FROM inventory.assets a
 JOIN inventory.asset_conditions c ON c.tenant_id=a.tenant_id AND c.id=a.condition_id
 WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.asset_id FOR UPDATE OF a;
 IF asset_state IS DISTINCT FROM 'available' OR allowed IS DISTINCT FROM true OR NEW.released_at IS NOT NULL THEN
 RAISE EXCEPTION 'Asset is not eligible for reservation' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER reservation_guard BEFORE INSERT OR UPDATE ON inventory.asset_reservations FOR EACH ROW EXECUTE FUNCTION inventory_security.reserve_asset();
CREATE FUNCTION inventory_security.sync_reservation_state() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ BEGIN
 IF TG_OP='INSERT' THEN
 UPDATE inventory.assets SET lifecycle_status='reserved' WHERE tenant_id=NEW.tenant_id AND id=NEW.asset_id;
 ELSIF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
 UPDATE inventory.assets SET lifecycle_status='available' WHERE tenant_id=NEW.tenant_id AND id=NEW.asset_id AND lifecycle_status='reserved';
 END IF; RETURN NEW; END $$;
CREATE TRIGGER reservation_state AFTER INSERT OR UPDATE ON inventory.asset_reservations FOR EACH ROW EXECUTE FUNCTION inventory_security.sync_reservation_state();

CREATE FUNCTION inventory_security.guard_depreciation() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,inventory AS $$ DECLARE cost numeric; residual numeric; accumulated numeric; kind text; is_depreciable boolean; BEGIN
 SELECT a.acquisition_cost,a.residual_value,c.asset_kind,c.depreciable INTO cost,residual,kind,is_depreciable FROM inventory.assets a
 JOIN inventory.asset_categories c ON c.tenant_id=a.tenant_id AND c.id=a.category_id
 WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.asset_id FOR UPDATE OF a;
 IF kind IN ('land','inventory') OR is_depreciable IS DISTINCT FROM true THEN RAISE EXCEPTION 'Asset kind is not depreciable by default' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(amount),0) INTO accumulated FROM inventory.depreciation_entries WHERE tenant_id=NEW.tenant_id AND asset_id=NEW.asset_id;
 IF accumulated+NEW.amount<0 OR accumulated+NEW.amount>cost-residual OR NEW.book_value_after<>cost-accumulated-NEW.amount THEN
 RAISE EXCEPTION 'Depreciation amount/book value violates asset basis' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER depreciation_guard BEFORE INSERT ON inventory.depreciation_entries FOR EACH ROW EXECUTE FUNCTION inventory_security.guard_depreciation();
CREATE FUNCTION inventory_security.protect_snapshots() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='approval_instances' THEN
 IF (NEW.document_id,NEW.document_revision,NEW.workflow_version_id,NEW.requested_by,NEW.workflow_snapshot,NEW.payload_snapshot)
 IS DISTINCT FROM (OLD.document_id,OLD.document_revision,OLD.workflow_version_id,OLD.requested_by,OLD.workflow_snapshot,OLD.payload_snapshot) THEN
 RAISE EXCEPTION 'Submitted approval snapshot is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='stock_opname_items' THEN
 IF (NEW.session_id,NEW.asset_id,NEW.expected_room_id,NEW.expected_condition_id,NEW.snapshot_version)
 IS DISTINCT FROM (OLD.session_id,OLD.asset_id,OLD.expected_room_id,OLD.expected_condition_id,OLD.snapshot_version) THEN
 RAISE EXCEPTION 'Opname expected snapshot is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='approval_workflow_versions' AND OLD.published_at IS NOT NULL THEN
 RAISE EXCEPTION 'Published workflow version is immutable; create new version' USING ERRCODE='23514';
 END IF; RETURN NEW; END $$;
CREATE TRIGGER approval_snapshot BEFORE UPDATE ON inventory.approval_instances FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_snapshots();
CREATE TRIGGER opname_snapshot BEFORE UPDATE ON inventory.stock_opname_items FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_snapshots();
CREATE TRIGGER workflow_snapshot BEFORE UPDATE ON inventory.approval_workflow_versions FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_snapshots();
-- A used subcategory cannot be reparented to another category (FK constraint applies).
-- Revoke every newly created helper from PUBLIC in this migration as well.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
COMMIT;
