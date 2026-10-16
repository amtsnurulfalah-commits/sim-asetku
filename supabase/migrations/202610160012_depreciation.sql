BEGIN;
INSERT INTO inventory.permissions(code,description) VALUES('depreciation.approve','Menyetujui penyusutan dan koreksi') ON CONFLICT DO NOTHING;
INSERT INTO inventory.role_permissions(tenant_id,role_id,permission_code) SELECT tenant_id,id,'depreciation.approve' FROM inventory.roles WHERE code='admin' ON CONFLICT DO NOTHING;
ALTER TABLE inventory.depreciation_runs ADD COLUMN mode text NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal','correction'));
ALTER TABLE inventory.depreciation_runs ADD COLUMN input_snapshot jsonb;
ALTER TABLE inventory.depreciation_entries ADD COLUMN posting_sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX ON inventory.depreciation_entries(tenant_id,asset_id,posting_sequence);
CREATE TABLE inventory.depreciation_run_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),run_id uuid NOT NULL,asset_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('ready','excluded')),amount numeric(20,2) NOT NULL,plan jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,run_id,asset_id),FOREIGN KEY(tenant_id,run_id) REFERENCES inventory.depreciation_runs(tenant_id,id),FOREIGN KEY(tenant_id,asset_id) REFERENCES inventory.assets(tenant_id,id)
);
CREATE TABLE inventory.depreciation_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),asset_id uuid NOT NULL,entry_id uuid NOT NULL,
 effective_period date NOT NULL CHECK(extract(day from effective_period)=1),opening_accumulated numeric(20,2) NOT NULL CHECK(opening_accumulated>=0),remaining_months integer NOT NULL CHECK(remaining_months BETWEEN 0 AND 1200),revision_sequence bigint GENERATED ALWAYS AS IDENTITY,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,entry_id),
 FOREIGN KEY(tenant_id,asset_id) REFERENCES inventory.assets(tenant_id,id),FOREIGN KEY(tenant_id,entry_id,asset_id) REFERENCES inventory.depreciation_entries(tenant_id,id,asset_id)
);
CREATE TABLE inventory.depreciation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES inventory.tenants(id),document_id uuid NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,reason text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES inventory.business_documents(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES inventory.tenant_memberships(tenant_id,id)
);
DO $$ DECLARE tab text;BEGIN
FOREACH tab IN ARRAY ARRAY['depreciation_run_lines','depreciation_revisions','depreciation_events'] LOOP
 EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY migration_owner ON inventory.%I TO %I USING(true) WITH CHECK(true)',tab,current_user);
 EXECUTE format('CREATE POLICY tenant_scope ON inventory.%I TO inventory_runtime USING(tenant_id=inventory_security.tenant_id())',tab);
 EXECUTE format('GRANT SELECT ON inventory.%I TO inventory_runtime',tab);
 EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.audit_change()',tab);
 EXECUTE format('CREATE INDEX ON inventory.%I(tenant_id,created_at,id)',tab);
 IF tab<>'depreciation_run_lines' THEN EXECUTE format('CREATE TRIGGER no_rewrite BEFORE UPDATE OR DELETE ON inventory.%I FOR EACH ROW EXECUTE FUNCTION inventory_security.reject_rewrite()',tab);END IF;
END LOOP;END $$;
CREATE INDEX ON inventory.depreciation_run_lines(tenant_id,run_id);
CREATE INDEX ON inventory.depreciation_revisions(tenant_id,asset_id,effective_period,revision_sequence);
CREATE INDEX ON inventory.depreciation_events(tenant_id,document_id,created_at);
REVOKE INSERT,UPDATE,DELETE ON inventory.depreciation_runs,inventory.depreciation_entries FROM inventory_runtime;
CREATE FUNCTION inventory_security.depreciation_assert(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$ BEGIN
IF p_permission NOT IN ('depreciation.manage','assets.view','depreciation.approve') OR p_permission IS NULL THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501';END IF;RETURN inventory_security.assert_approval_actor(p_permission);END $$;
CREATE FUNCTION inventory_security.depreciation_period(p_period date) RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog,inventory AS $$ BEGIN
IF p_period IS NULL OR extract(day from p_period)<>1 OR p_period<'1900-01-01'::date OR (p_period+interval '1 month')::date>(SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM inventory.tenants WHERE id=inventory_security.tenant_id()) THEN RAISE EXCEPTION 'Closed monthly period required' USING ERRCODE='23514';END IF;END $$;
-- Pure numeric cumulative schedule, rounded only at the cumulative target. Cutoff/end are exclusive dates.
CREATE FUNCTION inventory_security.straight_line_target(p_base numeric,p_life integer,p_start date,p_period date,p_proration text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE firstmonth date;elapsed integer;ending date;cutoff date:=(p_period+interval '1 month')::date;days_elapsed integer;days_total integer;BEGIN
IF p_base IS NULL OR p_base<0 OR p_life IS NULL OR p_life NOT BETWEEN 1 AND 1200 OR p_start IS NULL OR p_proration IS NULL OR p_proration NOT IN ('full_month','next_month','daily') THEN RAISE EXCEPTION 'Invalid straight-line basis' USING ERRCODE='23514';END IF;
IF p_proration='daily' THEN ending:=(p_start+make_interval(months=>p_life))::date;days_total:=ending-p_start;days_elapsed:=greatest(0,least(cutoff,ending)-p_start);RETURN round(p_base*days_elapsed/days_total,2);END IF;
firstmonth:=date_trunc('month',p_start)::date;IF p_proration='next_month' THEN firstmonth:=(firstmonth+interval '1 month')::date;END IF;
elapsed:=(extract(year from p_period)::int-extract(year from firstmonth)::int)*12+extract(month from p_period)::int-extract(month from firstmonth)::int+1;
RETURN round(p_base*greatest(0,least(elapsed,p_life))/p_life,2);END $$;
CREATE FUNCTION inventory_security.depreciation_basis(p_asset uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();a inventory.assets;p inventory.depreciation_policies;c inventory.asset_categories;prior numeric;last_period date;ledger_hash text;r inventory.depreciation_revisions;construction text;BEGIN
SELECT * INTO a FROM inventory.assets WHERE tenant_id=t AND id=p_asset;IF NOT FOUND THEN RAISE EXCEPTION 'Asset not found' USING ERRCODE='P0002';END IF;
SELECT * INTO c FROM inventory.asset_categories WHERE tenant_id=t AND id=a.category_id;SELECT * INTO p FROM inventory.depreciation_policies WHERE tenant_id=t AND id=a.depreciation_policy_id;
SELECT construction_status INTO construction FROM inventory.asset_building_details WHERE tenant_id=t AND asset_id=a.id;
SELECT coalesce(sum(amount),0),max(period),encode(sha256(convert_to(coalesce(string_agg(id::text||':'||amount::text,',' ORDER BY posting_sequence),''),'UTF8')),'hex') INTO prior,last_period,ledger_hash FROM inventory.depreciation_entries WHERE tenant_id=t AND asset_id=a.id;
SELECT * INTO r FROM inventory.depreciation_revisions WHERE tenant_id=t AND asset_id=a.id ORDER BY effective_period DESC,revision_sequence DESC LIMIT 1;
RETURN jsonb_build_object('cost',a.acquisition_cost::text,'residual',a.residual_value::text,'life',a.useful_life_months,'start',a.in_service_date,'policyId',p.id,'policyVersion',p.version,'method',p.method,'proration',p.proration,'categoryId',c.id,'kind',c.asset_kind,'depreciable',c.depreciable,'construction',construction,'prior',prior::text,'lastPeriod',last_period,'ledgerHash',ledger_hash,'revisionId',r.id,'revisionPeriod',r.effective_period,'opening',r.opening_accumulated::text,'remaining',r.remaining_months);END $$;
CREATE FUNCTION inventory_security.depreciation_plan(p_asset uuid,p_period date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();a inventory.assets;b jsonb;why text;prior numeric;target numeric;expense numeric;base numeric;elapsed integer;profile_period date;result jsonb;BEGIN
SELECT * INTO a FROM inventory.assets WHERE tenant_id=t AND id=p_asset;IF NOT FOUND THEN RAISE EXCEPTION 'Asset not found' USING ERRCODE='P0002';END IF;
b:=inventory_security.depreciation_basis(a.id);prior:=(b->>'prior')::numeric;base:=a.acquisition_cost-a.residual_value;
IF b->>'kind' IN ('land','inventory') OR (b->>'depreciable')::boolean IS DISTINCT FROM true THEN why:='nondepreciable';
ELSIF a.lifecycle_status NOT IN ('available','reserved','on_loan','maintenance') THEN why:='inactive_asset';
ELSIF b->>'construction'='in_progress' THEN why:='construction_in_progress';
ELSIF b->>'policyId' IS NULL OR b->>'life' IS NULL OR b->>'method'<>'straight_line' THEN why:='missing_policy';
ELSIF a.in_service_date IS NULL THEN why:='missing_start';
ELSIF a.in_service_date>=(p_period+interval '1 month')::date THEN why:='not_started';
ELSIF EXISTS(SELECT FROM inventory.depreciation_entries WHERE tenant_id=t AND asset_id=a.id AND period=p_period AND correction_of IS NULL) THEN why:='already_posted';
ELSIF (b->>'lastPeriod')::date>p_period THEN why:='later_period_exists';
ELSIF prior>=base THEN why:='fully_depreciated';
END IF;
IF why IS NULL THEN
 IF b->>'revisionId' IS NOT NULL THEN
 profile_period:=(b->>'revisionPeriod')::date;elapsed:=(extract(year from p_period)::int-extract(year from profile_period)::int)*12+extract(month from p_period)::int-extract(month from profile_period)::int;
 IF elapsed<=0 THEN why:='revised_period';
 ELSE target:=(b->>'opening')::numeric+CASE WHEN (b->>'remaining')::integer=0 THEN 0 ELSE round((base-(b->>'opening')::numeric)*least(elapsed,(b->>'remaining')::integer)/(b->>'remaining')::integer,2) END;END IF;
 ELSE target:=inventory_security.straight_line_target(base,(b->>'life')::integer,a.in_service_date,p_period,b->>'proration');END IF;
 IF why IS NULL THEN IF target<prior THEN why:='over_schedule';ELSIF target=0 AND prior=0 THEN why:='not_started';ELSE expense:=least(base-prior,target-prior);END IF;END IF;
END IF;
result:=jsonb_build_object('assetId',a.id,'code',a.inventory_code,'name',a.name,'room',(SELECT name FROM inventory.rooms WHERE tenant_id=t AND id=a.room_id),'period',p_period,'status',CASE WHEN why IS NULL THEN 'ready' ELSE 'excluded' END,'reason',why,'amount',coalesce(expense,0)::text,'cost',a.acquisition_cost::text,'residual',a.residual_value::text,'prior',prior::text,'target',coalesce(target,prior)::text,'bookBefore',(a.acquisition_cost-prior)::text,'bookAfter',(a.acquisition_cost-prior-coalesce(expense,0))::text,'basis',b,'convention',CASE WHEN b->>'revisionId' IS NOT NULL THEN 'prospective_full_month' ELSE b->>'proration' END);
RETURN result;END $$;
CREATE FUNCTION inventory_security.depreciation_correction_plan(p_entry uuid,p_target numeric,p_remaining integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();e inventory.depreciation_entries;a inventory.assets;b jsonb;base numeric;prior numeric;BEGIN
SELECT * INTO e FROM inventory.depreciation_entries WHERE tenant_id=t AND id=p_entry AND correction_of IS NULL;IF NOT FOUND THEN RAISE EXCEPTION 'Original normal entry required' USING ERRCODE='23514';END IF;
SELECT * INTO a FROM inventory.assets WHERE tenant_id=t AND id=e.asset_id;b:=inventory_security.depreciation_basis(a.id);base:=a.acquisition_cost-a.residual_value;prior:=(b->>'prior')::numeric;
IF e.period IS DISTINCT FROM (b->>'lastPeriod')::date OR p_target IS NULL OR p_target<>round(p_target,2) OR p_target<0 OR p_target>base OR p_remaining IS NULL OR p_remaining NOT BETWEEN 0 AND 1200 OR p_target<base AND p_remaining=0 OR p_target=base AND p_remaining<>0 THEN RAISE EXCEPTION 'Correction must address latest posted period with bounded accumulated value and explicit remaining life' USING ERRCODE='23514';END IF;
IF p_target=prior AND b->>'revisionPeriod'=e.period::text AND p_remaining=(b->>'remaining')::integer THEN RAISE EXCEPTION 'No correction change' USING ERRCODE='23514';END IF;
RETURN jsonb_build_object('assetId',a.id,'code',a.inventory_code,'name',a.name,'period',e.period,'status','ready','amount',(p_target-prior)::text,'cost',a.acquisition_cost::text,'residual',a.residual_value::text,'prior',prior::text,'target',p_target::text,'bookBefore',(a.acquisition_cost-prior)::text,'bookAfter',(a.acquisition_cost-p_target)::text,'basis',b,'correctionOf',e.id,'remainingMonths',p_remaining,'convention','prospective_full_month');END $$;
CREATE FUNCTION inventory_security.depreciation_preview(p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();period date:=(p_data->>'period')::date;mode text:=p_data->>'mode';plans jsonb:='[]';ids uuid[];aid uuid;v jsonb;row jsonb;BEGIN
PERFORM inventory_security.depreciation_assert('depreciation.manage');
IF mode='normal' THEN
 PERFORM inventory_security.depreciation_period(period);
 IF p_data->>'roomId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.rooms WHERE tenant_id=t AND id=(p_data->>'roomId')::uuid) OR p_data->>'categoryId' IS NOT NULL AND NOT EXISTS(SELECT FROM inventory.asset_categories WHERE tenant_id=t AND id=(p_data->>'categoryId')::uuid) THEN RAISE EXCEPTION 'Scope tenant mismatch' USING ERRCODE='23514';END IF;
 IF p_data->'assetIds' IS NOT NULL AND jsonb_array_length(p_data->'assetIds')>0 THEN SELECT array_agg(value::uuid ORDER BY value) INTO ids FROM jsonb_array_elements_text(p_data->'assetIds');IF cardinality(ids)>200 OR cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) OR EXISTS(SELECT FROM unnest(ids) x WHERE NOT EXISTS(SELECT FROM inventory.assets WHERE tenant_id=t AND id=x)) THEN RAISE EXCEPTION 'Invalid selected assets' USING ERRCODE='23514';END IF;
 ELSE SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM inventory.assets WHERE tenant_id=t AND (p_data->>'roomId' IS NULL OR room_id=(p_data->>'roomId')::uuid) AND (p_data->>'categoryId' IS NULL OR category_id=(p_data->>'categoryId')::uuid) ORDER BY id LIMIT 1001) scope;END IF;
 IF coalesce(cardinality(ids),0)=0 OR cardinality(ids)>1000 THEN RAISE EXCEPTION 'Scope requires 1..1000 assets' USING ERRCODE='23514';END IF;
 FOREACH aid IN ARRAY ids LOOP plans:=plans||jsonb_build_array(inventory_security.depreciation_plan(aid,period));END LOOP;
ELSIF mode='correction' THEN
 IF jsonb_typeof(p_data->'corrections') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'corrections') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Select 1..50 correction lines' USING ERRCODE='23514';END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_data->'corrections') LOOP
 v:=inventory_security.depreciation_correction_plan((row->>'entryId')::uuid,(row->>'targetAccumulated')::numeric,(row->>'remainingMonths')::integer);
 IF period IS NULL THEN period:=(v->>'period')::date;END IF;
 IF period<>(v->>'period')::date OR EXISTS(SELECT FROM jsonb_array_elements(plans) j WHERE j->>'assetId'=v->>'assetId') THEN RAISE EXCEPTION 'Correction lines must have the same latest period and distinct assets' USING ERRCODE='23514';END IF;plans:=plans||jsonb_build_array(v);
 END LOOP;PERFORM inventory_security.depreciation_period(period);
ELSE RAISE EXCEPTION 'Unknown depreciation mode' USING ERRCODE='23514';END IF;
RETURN jsonb_build_object('period',period,'mode',mode,'lines',plans,'total',(SELECT coalesce(sum((j->>'amount')::numeric),0)::text FROM jsonb_array_elements(plans) j),'ready',(SELECT count(*) FROM jsonb_array_elements(plans) j WHERE j->>'status'='ready'));END $$;
CREATE FUNCTION inventory_security.depreciation_save(p_id uuid,p_version bigint,p_key uuid,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;r inventory.depreciation_runs;preview jsonb;v jsonb;bid uuid;rid uuid;num text;digest text;prior inventory.idempotency_records;period date;mode text:=p_data->>'mode';BEGIN
actor:=inventory_security.depreciation_assert('depreciation.manage');
IF p_key IS NULL OR p_data->>'reason' IS NULL OR length(btrim(p_data->>'reason')) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Reason and idempotency key required' USING ERRCODE='23514';END IF;
digest:=encode(sha256(convert_to(p_data::text||actor::text||coalesce(p_id::text,'new')||coalesce(p_version::text,'new'),'UTF8')),'hex');
SELECT * INTO prior FROM inventory.idempotency_records WHERE tenant_id=t AND operation='depreciation.save' AND idempotency_key=p_key::text;
IF FOUND THEN IF prior.request_digest<>digest THEN RAISE EXCEPTION 'Idempotency mismatch' USING ERRCODE='23514';END IF;RETURN prior.resource_id;END IF;
IF p_id IS NOT NULL THEN
 SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;SELECT * INTO r FROM inventory.depreciation_runs WHERE tenant_id=t AND business_document_id=p_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
 IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
 IF d.requested_by<>actor OR d.status NOT IN ('draft','revision_required') OR r.mode<>mode THEN RAISE EXCEPTION 'Owner editable run with same mode required' USING ERRCODE='42501';END IF;
END IF;
preview:=inventory_security.depreciation_preview(p_data);period:=(preview->>'period')::date;
IF (preview->>'ready')::int=0 THEN RAISE EXCEPTION 'No ready depreciation lines' USING ERRCODE='23514';END IF;
IF p_id IS NULL THEN
 num:='DEP-'||upper(mode)||'/'||inventory_security.next_number('depreciation:'||mode,0)::text;
 INSERT INTO inventory.business_documents(tenant_id,document_number,business_date,requested_by,document_type,input_snapshot,supply_reason) VALUES(t,num,(period+interval '1 month'-interval '1 day')::date,actor,CASE mode WHEN 'normal' THEN 'finance:depreciation' ELSE 'finance:depreciation_correction' END,p_data,p_data->>'reason') RETURNING id INTO bid;
 INSERT INTO inventory.depreciation_runs(tenant_id,document_number,business_date,requested_by,period,policy_snapshot,business_document_id,mode,input_snapshot) VALUES(t,num,(period+interval '1 month'-interval '1 day')::date,actor,period,jsonb_build_object('calculationVersion','straight_line_v1','calculation',preview),bid,mode,p_data) RETURNING id INTO rid;
ELSE
 bid:=d.id;rid:=r.id;DELETE FROM inventory.depreciation_run_lines WHERE tenant_id=t AND run_id=rid;
 UPDATE inventory.business_documents SET business_date=(period+interval '1 month'-interval '1 day')::date,input_snapshot=p_data,supply_reason=p_data->>'reason',status='draft',revision=revision+1,source_revision=source_revision+1,review_mode_snapshot=NULL WHERE id=bid;
 UPDATE inventory.depreciation_runs SET business_date=((preview->>'period')::date+interval '1 month'-interval '1 day')::date,period=(preview->>'period')::date,status='draft',revision=revision+1,input_snapshot=p_data,policy_snapshot=jsonb_build_object('calculationVersion','straight_line_v1','calculation',preview) WHERE id=rid;
END IF;
FOR v IN SELECT value FROM jsonb_array_elements(preview->'lines') LOOP INSERT INTO inventory.depreciation_run_lines(tenant_id,run_id,asset_id,status,amount,plan) VALUES(t,rid,(v->>'assetId')::uuid,v->>'status',(v->>'amount')::numeric,v);END LOOP;
INSERT INTO inventory.depreciation_events(tenant_id,document_id,actor_id,action,reason,details) VALUES(t,bid,actor,CASE WHEN p_id IS NULL THEN 'calculate' ELSE 'recalculate' END,p_data->>'reason',jsonb_build_object('digest',digest,'ready',preview->>'ready','total',preview->>'total'));
INSERT INTO inventory.idempotency_records(tenant_id,operation,idempotency_key,request_digest,resource_id,expires_at) VALUES(t,'depreciation.save',p_key::text,digest,bid,clock_timestamp()+interval '10 years');RETURN bid;END $$;
CREATE FUNCTION inventory_security.depreciation_post(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;r inventory.depreciation_runs;l inventory.depreciation_run_lines;fresh jsonb;eid uuid;n integer:=0;BEGIN
actor:=inventory_security.depreciation_assert('depreciation.manage');SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_id FOR UPDATE;SELECT * INTO r FROM inventory.depreciation_runs WHERE tenant_id=t AND business_document_id=p_id FOR UPDATE;
IF r.id IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
IF d.status='posted' THEN RETURN jsonb_build_object('id',p_id,'reused',true);END IF;
PERFORM inventory_security.approval_assert_post(p_id);PERFORM inventory_security.depreciation_period(r.period);
FOR l IN SELECT * FROM inventory.depreciation_run_lines WHERE tenant_id=t AND run_id=r.id AND status='ready' ORDER BY asset_id LOOP
 PERFORM 1 FROM inventory.assets WHERE tenant_id=t AND id=l.asset_id FOR UPDATE;
 IF r.mode='normal' THEN fresh:=inventory_security.depreciation_plan(l.asset_id,r.period);
 ELSE fresh:=inventory_security.depreciation_correction_plan((l.plan->>'correctionOf')::uuid,(l.plan->>'target')::numeric,(l.plan->>'remainingMonths')::integer);END IF;
 IF fresh->>'status'<>'ready' OR fresh->'basis' IS DISTINCT FROM l.plan->'basis' OR fresh->>'amount' IS DISTINCT FROM l.plan->>'amount' OR fresh->>'target' IS DISTINCT FROM l.plan->>'target' THEN RAISE EXCEPTION 'Depreciation snapshot stale; recalculate and reapprove' USING ERRCODE='40001';END IF;
 INSERT INTO inventory.depreciation_entries(tenant_id,run_id,asset_id,period,amount,book_value_after,correction_of,reason,posting_key) VALUES(t,r.id,l.asset_id,r.period,l.amount,(l.plan->>'bookAfter')::numeric,(l.plan->>'correctionOf')::uuid,d.supply_reason,'depreciation:'||l.id::text) RETURNING id INTO eid;
 IF r.mode='correction' THEN INSERT INTO inventory.depreciation_revisions(tenant_id,asset_id,entry_id,effective_period,opening_accumulated,remaining_months) VALUES(t,l.asset_id,eid,r.period,(l.plan->>'target')::numeric,(l.plan->>'remainingMonths')::int);END IF;
 n:=n+1;
END LOOP;
IF n=0 THEN RAISE EXCEPTION 'No ready lines' USING ERRCODE='23514';END IF;
UPDATE inventory.depreciation_runs SET status='posted' WHERE id=r.id;UPDATE inventory.business_documents SET status='posted',posted_at=clock_timestamp(),posting_key=p_id::text WHERE id=p_id;
INSERT INTO inventory.depreciation_events(tenant_id,document_id,actor_id,action,reason,details) VALUES(t,p_id,actor,'post',d.supply_reason,jsonb_build_object('count',n));RETURN jsonb_build_object('id',p_id,'reused',false,'count',n);END $$;
CREATE FUNCTION inventory_security.freeze_depreciated_basis() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,inventory AS $$ BEGIN
IF (NEW.acquisition_date,NEW.category_id,NEW.acquisition_cost,NEW.residual_value,NEW.depreciation_policy_id,NEW.useful_life_months,NEW.in_service_date) IS DISTINCT FROM (OLD.acquisition_date,OLD.category_id,OLD.acquisition_cost,OLD.residual_value,OLD.depreciation_policy_id,OLD.useful_life_months,OLD.in_service_date) AND EXISTS(SELECT FROM inventory.depreciation_entries WHERE tenant_id=OLD.tenant_id AND asset_id=OLD.id) THEN RAISE EXCEPTION 'Posted accounting basis immutable even after full correction' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER freeze_depreciated_basis BEFORE UPDATE ON inventory.assets FOR EACH ROW EXECUTE FUNCTION inventory_security.freeze_depreciated_basis();
CREATE FUNCTION inventory_security.protect_depreciation_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,inventory AS $$ BEGIN
IF TG_TABLE_NAME='depreciation_runs' THEN
 IF OLD.status NOT IN ('draft','revision_required') AND (NEW.period,NEW.policy_snapshot,NEW.input_snapshot,NEW.mode) IS DISTINCT FROM (OLD.period,OLD.policy_snapshot,OLD.input_snapshot,OLD.mode) THEN RAISE EXCEPTION 'Depreciation run snapshot immutable after submission' USING ERRCODE='23514';END IF;
ELSE
 IF EXISTS(SELECT FROM inventory.depreciation_runs WHERE tenant_id=OLD.tenant_id AND id=OLD.run_id AND status NOT IN ('draft','revision_required')) THEN RAISE EXCEPTION 'Depreciation lines immutable after submission' USING ERRCODE='23514';END IF;
END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE TRIGGER depreciation_run_snapshot BEFORE UPDATE ON inventory.depreciation_runs FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_depreciation_snapshot();
CREATE TRIGGER depreciation_line_snapshot BEFORE UPDATE OR DELETE ON inventory.depreciation_run_lines FOR EACH ROW EXECUTE FUNCTION inventory_security.protect_depreciation_snapshot();

CREATE OR REPLACE FUNCTION inventory_security.approval_permission(k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE
WHEN k IN ('finance:depreciation','finance:depreciation_correction') THEN 'depreciation.approve' WHEN k IN ('supply:request','supply:order') THEN 'procurement.approve' WHEN k IN ('supply:receipt','supply:receipt_stock') THEN 'receipts.approve' WHEN k='supply:issue' THEN 'inventory.issue.approve' WHEN k='supply:adjustment' THEN 'inventory.adjust.approve'
WHEN k IN ('asset:placement','asset:movement') THEN 'movements.approve' WHEN k IN ('asset:loan','asset:return') THEN 'loans.approve' WHEN k IN ('asset:maintenance','asset:maintenance_finish') THEN 'maintenance.approve' WHEN k='asset:opname' THEN 'stockopname.approve' WHEN k='asset:disposal' THEN 'disposal.approve' END $$;
CREATE OR REPLACE FUNCTION inventory_security.assert_approval_actor(p_permission text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();u uuid:=inventory_security.user_id();s inventory.app_sessions;m inventory.tenant_memberships;
BEGIN
IF p_permission='approval.manage' THEN RETURN inventory_security.approval_admin();ELSIF p_permission='settings.manage' THEN RETURN inventory_security.assert_tenant_admin(); END IF;
IF p_permission NOT IN ('depreciation.manage','depreciation.approve','approval.access','procurement.approve','receipts.approve','inventory.issue.approve','inventory.adjust.approve','maintenance.approve','movements.approve','loans.approve','stockopname.approve','disposal.approve','assets.view','inventory.view','procurement.manage','inventory.receive','inventory.issue','inventory.adjust','movements.create','loans.create','maintenance.manage','stockopname.execute','disposal.create','files.download','files.sensitive.download') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
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
CREATE OR REPLACE FUNCTION inventory_security.approval_context(p_doc uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;x inventory.asset_transactions;amount numeric:=0;correction boolean:=false;BEGIN
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc;IF NOT FOUND OR inventory_security.approval_permission(d.document_type) IS NULL THEN RAISE EXCEPTION 'Unsupported approval document' USING ERRCODE='23514';END IF;
IF d.document_type IN ('finance:depreciation','finance:depreciation_correction') THEN SELECT coalesce(sum(CASE WHEN r.mode='correction' THEN greatest(abs(l.amount),(l.plan->>'bookBefore')::numeric-(l.plan->>'residual')::numeric) ELSE abs(l.amount) END),0) INTO amount FROM inventory.depreciation_runs r JOIN inventory.depreciation_run_lines l ON l.tenant_id=r.tenant_id AND l.run_id=r.id WHERE r.tenant_id=t AND r.business_document_id=p_doc AND l.status='ready';correction:=d.document_type='finance:depreciation_correction';
ELSIF d.supply_kind='request' THEN SELECT coalesce(sum(round(i.quantity*i.estimated_unit_cost,2)),0) INTO amount FROM inventory.procurement_request_items i JOIN inventory.procurement_requests r ON r.tenant_id=i.tenant_id AND r.id=i.request_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
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
CREATE OR REPLACE FUNCTION inventory_security.approval_set_status(p_doc uuid,p_status text,p_revision integer DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();k text;tab text;BEGIN
UPDATE inventory.business_documents SET status=p_status,revision=coalesce(p_revision,revision) WHERE tenant_id=t AND id=p_doc RETURNING supply_kind INTO k;
IF k IS NOT NULL THEN tab:=inventory_security.supply_source(k);EXECUTE format('UPDATE inventory.%I SET status=$1,revision=coalesce($2,revision) WHERE tenant_id=$3 AND business_document_id=$4',tab) USING p_status,p_revision,t,p_doc;END IF;UPDATE inventory.depreciation_runs SET status=p_status,revision=coalesce(p_revision,revision) WHERE tenant_id=t AND business_document_id=p_doc;END $$;
CREATE OR REPLACE FUNCTION inventory_security.approval_payload(p_doc uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();d inventory.business_documents;rows jsonb;BEGIN
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc;
IF d.document_type IN ('finance:depreciation','finance:depreciation_correction') THEN SELECT jsonb_agg(jsonb_build_object('name',l.plan->>'name','code',l.plan->>'code','period',l.plan->>'period','amount',l.amount::text,'cost',l.plan->>'cost','residual',l.plan->>'residual','prior',l.plan->>'prior','target',l.plan->>'target','bookBefore',l.plan->>'bookBefore','bookAfter',l.plan->>'bookAfter','remainingMonths',l.plan->>'remainingMonths','convention',l.plan->>'convention','status',l.status,'notes',l.plan->>'reason') ORDER BY l.plan->>'code') INTO rows FROM inventory.depreciation_runs r JOIN inventory.depreciation_run_lines l ON l.tenant_id=r.tenant_id AND l.run_id=r.id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind='request' THEN SELECT jsonb_agg(jsonb_build_object('name',i.description,'quantity',i.quantity::text,'unitCost',i.estimated_unit_cost::text,'unit',u.name) ORDER BY i.line_number) INTO rows FROM inventory.procurement_requests r JOIN inventory.procurement_request_items i ON i.tenant_id=r.tenant_id AND i.request_id=r.id JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind='order' THEN SELECT jsonb_agg(jsonb_build_object('name',i.description,'quantity',i.quantity::text,'unitCost',i.unit_cost::text,'unit',u.name,'destination',i.destination_kind) ORDER BY i.line_number) INTO rows FROM inventory.procurements r JOIN inventory.procurement_items i ON i.tenant_id=r.tenant_id AND i.procurement_id=r.id JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind='receipt' THEN SELECT jsonb_agg(jsonb_build_object('name',p.description,'quantity',i.quantity::text,'accepted',i.accepted_quantity::text,'unitCost',p.unit_cost::text,'room',room.name,'notes',i.inspection_notes) ORDER BY i.line_number) INTO rows FROM inventory.goods_receipts r JOIN inventory.goods_receipt_items i ON i.tenant_id=r.tenant_id AND i.receipt_id=r.id JOIN inventory.procurement_items p ON p.tenant_id=i.tenant_id AND p.id=i.procurement_item_id JOIN inventory.rooms room ON room.tenant_id=i.tenant_id AND room.id=i.room_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSIF d.supply_kind IS NOT NULL THEN SELECT jsonb_agg(jsonb_build_object('name',item.name,'quantity',i.quantity_delta::text,'unitCost',i.unit_cost::text,'room',room.name) ORDER BY i.line_number) INTO rows FROM inventory.inventory_adjustments r JOIN inventory.inventory_transaction_lines i ON i.tenant_id=r.tenant_id AND i.adjustment_id=r.id JOIN inventory.inventory_items item ON item.tenant_id=i.tenant_id AND item.id=i.item_id JOIN inventory.rooms room ON room.tenant_id=i.tenant_id AND room.id=i.room_id WHERE r.tenant_id=t AND r.business_document_id=p_doc;
ELSE SELECT jsonb_agg(jsonb_build_object('name',l.snapshot->>'name','code',l.snapshot->>'code','room',room.name,'condition',cond.name,'finding',l.observation->>'finding','observedRoom',observed.name,'observedCondition',oc.name,'notes',l.observation->>'notes') ORDER BY l.snapshot->>'code') INTO rows FROM inventory.asset_transaction_lines l LEFT JOIN inventory.rooms room ON room.tenant_id=l.tenant_id AND room.id=(l.snapshot->>'roomId')::uuid LEFT JOIN inventory.asset_conditions cond ON cond.tenant_id=l.tenant_id AND cond.id=(l.snapshot->>'conditionId')::uuid LEFT JOIN inventory.rooms observed ON observed.tenant_id=l.tenant_id AND observed.id=(l.observation->>'roomId')::uuid LEFT JOIN inventory.asset_conditions oc ON oc.tenant_id=l.tenant_id AND oc.id=(l.observation->>'conditionId')::uuid WHERE l.tenant_id=t AND l.transaction_id=p_doc;
END IF;
RETURN jsonb_build_object('input',d.input_snapshot,'sourceRevision',d.source_revision,'summary',jsonb_build_object('documentNumber',d.document_number,'date',d.business_date::text,'reason',d.supply_reason,'borrower',d.input_snapshot->>'borrower','startAt',d.input_snapshot->>'startAt','dueAt',d.input_snapshot->>'dueAt','completedAt',d.input_snapshot->>'completedAt','targetRoom',(SELECT name FROM inventory.rooms WHERE tenant_id=t AND id=(d.input_snapshot->>'roomId')::uuid),'targetCondition',(SELECT name FROM inventory.asset_conditions WHERE tenant_id=t AND id=(d.input_snapshot->>'conditionId')::uuid),'responsible',(SELECT u.full_name_snapshot FROM inventory.tenant_memberships m JOIN inventory.app_users u ON u.id=m.app_user_id WHERE m.tenant_id=t AND m.id=(d.input_snapshot->>'responsibleId')::uuid),'costTreatment',d.input_snapshot->>'costTreatment','lines',coalesce(rows,'[]'::jsonb),'unregistered',coalesce((SELECT jsonb_agg(reason ORDER BY created_at) FROM inventory.asset_transaction_events WHERE tenant_id=t AND transaction_id=p_doc AND action='unregistered'),'[]'::jsonb)),
'assetLines',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM inventory.asset_transaction_lines l WHERE l.tenant_id=t AND l.transaction_id=p_doc),'[]'::jsonb),
'files',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',f.original_filename,'sensitivity',f.sensitivity,'checksum',f.checksum) ORDER BY a.id) FROM inventory.document_attachments a JOIN inventory.file_attachments f ON f.tenant_id=a.tenant_id AND f.id=a.file_id WHERE a.tenant_id=t AND a.document_id=p_doc AND f.status='ready'),'[]'::jsonb));END $$;
CREATE OR REPLACE FUNCTION inventory_security.approval_submit(p_doc uuid,p_version bigint,p_reason text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;ctx jsonb;w inventory.approval_workflows;v inventory.approval_workflow_versions;r record;chosen uuid;matches int:=0;iid uuid;st inventory.approval_instance_steps;inst inventory.approval_instances;workflow_json jsonb;revision int;eligible boolean;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;
SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_approval_actor(CASE WHEN d.document_type IN ('finance:depreciation','finance:depreciation_correction') THEN 'depreciation.manage' WHEN d.supply_kind IS NOT NULL THEN inventory_security.supply_permission(d.supply_kind) ELSE inventory_security.transaction_permission(substr(d.document_type,7)) END);
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
CREATE OR REPLACE FUNCTION inventory_security.approval_cancel(p_doc uuid,p_version bigint,p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;d inventory.business_documents;inst inventory.approval_instances;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;SELECT * INTO d FROM inventory.business_documents WHERE tenant_id=t AND id=p_doc FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
actor:=inventory_security.assert_approval_actor(CASE WHEN d.document_type IN ('finance:depreciation','finance:depreciation_correction') THEN 'depreciation.manage' WHEN d.supply_kind IS NOT NULL THEN inventory_security.supply_permission(d.supply_kind) ELSE inventory_security.transaction_permission(substr(d.document_type,7)) END);
IF d.requested_by<>actor THEN RAISE EXCEPTION 'Owner cancellation required' USING ERRCODE='42501';END IF;
IF p_version IS NULL OR d.row_version<>p_version THEN RAISE EXCEPTION 'Stale document' USING ERRCODE='40001';END IF;
IF d.status NOT IN ('pending','partially_approved','revision_required','draft','rejected') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Not cancellable' USING ERRCODE='23514';END IF;
SELECT * INTO inst FROM inventory.approval_instances WHERE tenant_id=t AND document_id=p_doc AND document_revision=d.revision FOR UPDATE;
IF inst.status IN ('pending','partially_approved') THEN
UPDATE inventory.approval_instances SET status='cancelled',finalized_at=clock_timestamp() WHERE id=inst.id;UPDATE inventory.approval_instance_steps SET status='cancelled' WHERE tenant_id=t AND instance_id=inst.id AND status='pending';END IF;
PERFORM inventory_security.approval_set_status(p_doc,'cancelled');
INSERT INTO inventory.approval_events(tenant_id,document_id,instance_id,actor_id,action,reason) VALUES(t,p_doc,inst.id,actor,'cancel',p_reason);END $$;
CREATE OR REPLACE FUNCTION inventory_security.approval_publish(p_id uuid,p_version bigint,p_key uuid,p_data jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,inventory AS $$
DECLARE t uuid:=inventory_security.tenant_id();actor uuid;wid uuid;ver uuid;old inventory.approval_workflows;level int:=0;member uuid;step jsonb;req text:=inventory_security.approval_permission(p_data->>'type');minv numeric:=(p_data->>'minAmount')::numeric;maxv numeric:=(p_data->>'maxAmount')::numeric;prior inventory.idempotency_records;digest text;rules jsonb;BEGIN
PERFORM 1 FROM inventory.tenants WHERE id=t FOR UPDATE;actor:=inventory_security.approval_admin();
IF p_key IS NULL OR req IS NULL OR p_data->>'reason' IS NULL OR length(btrim(p_data->>'reason')) NOT BETWEEN 3 AND 2000 OR length(p_data->>'code') NOT BETWEEN 1 AND 64 OR length(btrim(p_data->>'name')) NOT BETWEEN 1 AND 300 OR minv IS NULL OR minv<0 OR maxv IS NOT NULL AND maxv<=minv OR p_data->>'scope' IS NULL OR p_data->>'scope' NOT IN ('all','standard','correction') OR p_data->>'scope'='correction' AND p_data->>'type' NOT IN ('supply:adjustment','finance:depreciation_correction') OR jsonb_typeof(p_data->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'steps') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid workflow configuration' USING ERRCODE='23514';END IF;
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inventory_security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_security.depreciation_assert(text),inventory_security.depreciation_preview(jsonb),inventory_security.depreciation_save(uuid,bigint,uuid,jsonb),inventory_security.depreciation_post(uuid) TO inventory_runtime;
COMMIT;
