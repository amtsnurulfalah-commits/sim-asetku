import {Pool} from 'pg';
const results=[];
for(const [key,role,other]of [['AUTH_DATABASE_URL','inventory_auth','inventory_runtime'],['DATABASE_URL','inventory_runtime','inventory_auth']]){
 let pool;
 try{
  if(!process.env[key])throw Error('MISSING');const u=new URL(process.env[key]);for(const k of ['sslmode','sslcert','sslkey','sslrootcert'])u.searchParams.delete(k);
  pool=new Pool({connectionString:u.toString(),max:1,connectionTimeoutMillis:8000,statement_timeout:10000,ssl:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT}:{})}});
  const c=await pool.connect();try{
   await c.query('BEGIN READ ONLY');
   const login=(await c.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,pg_has_role(current_user,$1,'MEMBER') member,pg_has_role(current_user,$2,'MEMBER') other FROM pg_roles r WHERE r.rolname=current_user`,[role,other])).rows[0];
   if(!login||!login.member||login.other||Object.entries(login).some(([k,v])=>!['member','other'].includes(k)&&v))throw Error('UNSAFE_LOGIN');
   const owners=(await c.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('inventory','inventory_security') AND pg_has_role(current_user,c.relowner,'MEMBER')`)).rows[0];if(owners.n)throw Error('OWNER_LOGIN');
   await c.query('SET LOCAL ROLE '+role);
   const counts=(await c.query(`SELECT count(*)::int n,count(*) FILTER(WHERE c.relrowsecurity AND c.relforcerowsecurity)::int secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='inventory' AND c.relkind='r'`)).rows[0];if(counts.n!==96||counts.secured!==96)throw Error('SCHEMA_OR_RLS_MISMATCH');
   if(role==='inventory_runtime'){
    await c.query("SELECT set_config('app.tenant_id','',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),set_config('app.session_digest','',true)");
    if((await c.query('SELECT count(*)::int n FROM inventory.assets')).rows[0].n!==0)throw Error('TENANT_CONTEXT_NOT_ISOLATED');
   }
   await c.query('ROLLBACK');results.push({key,status:'PASS'});
  }finally{c.release()}
 }catch(e){const allowed=['MISSING','UNSAFE_LOGIN','OWNER_LOGIN','SCHEMA_OR_RLS_MISMATCH','TENANT_CONTEXT_NOT_ISOLATED'];results.push({key,status:'FAIL',code:allowed.includes(e.message)?e.message:'CONNECTION_OR_PERMISSION_CHECK_FAILED'})}finally{await pool?.end()}
}
console.log(JSON.stringify({results,read_only:true,scope:'Role/TLS/schema smoke; not native concurrency or full production verification'},null,2));if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
