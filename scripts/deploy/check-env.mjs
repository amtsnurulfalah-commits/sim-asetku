import {pathToFileURL} from 'node:url';
export function checkEnvironment(e){
 const errors=[];const requireKey=k=>{if(!e[k])errors.push(k+': REQUIRED')};
 for(const k of ['APP_BASE_URL','CENTRAL_SSO_API_URL','CENTRAL_SSO_APPLICATION_ID','CENTRAL_SSO_KEY_ID','CENTRAL_SSO_CLIENT_SECRET','AUTH_DATABASE_URL','DATABASE_URL','RATE_LIMIT_SECRET','DRIVE_ACTIVE_KEY_ID','DRIVE_ENCRYPTION_KEYS'])requireKey(k);
 for(const k of ['APP_BASE_URL','CENTRAL_SSO_API_URL'])if(e[k]){try{const u=new URL(e[k]);if(u.protocol!=='https:'||u.origin!==e[k]||u.username||u.password||['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw 0}catch{errors.push(k+': HTTPS_ORIGIN_REQUIRED')}}
 if(e.CENTRAL_SSO_CLIENT_SECRET&&!/^[0-9a-f]{64}$/.test(e.CENTRAL_SSO_CLIENT_SECRET))errors.push('CENTRAL_SSO_CLIENT_SECRET: INVALID_FORMAT');
 if(e.RATE_LIMIT_SECRET&&(e.RATE_LIMIT_SECRET.length<32||e.RATE_LIMIT_SECRET===e.CENTRAL_SSO_CLIENT_SECRET))errors.push('RATE_LIMIT_SECRET: INVALID_OR_REUSED');
 for(const [k,re]of [['CENTRAL_SSO_APPLICATION_ID',/^[a-zA-Z0-9_.:-]{1,160}$/],['CENTRAL_SSO_KEY_ID',/^[a-zA-Z0-9_-]{1,64}$/]])if(e[k]&&!re.test(e[k]))errors.push(k+': INVALID_FORMAT');
 if(e.DATABASE_TLS_MODE&&e.DATABASE_TLS_MODE!=='verify-full')errors.push('DATABASE_TLS_MODE: VERIFY_FULL_REQUIRED');
 const users=[];
 for(const k of ['DATABASE_URL','AUTH_DATABASE_URL'])if(e[k])try{const u=new URL(e[k]);if(!['postgres:','postgresql:'].includes(u.protocol)||!u.username||!u.password||['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw 0;users.push(u.username);if(u.port==='6543')errors.push(k+': TRANSACTION_POOLER_NOT_APPROVED_USE_DIRECT_OR_SESSION');if(['postgres','supabase_admin'].includes(u.username.split('.')[0]))errors.push(k+': PRIVILEGED_LOGIN_FORBIDDEN');}catch{errors.push(k+': INVALID_REMOTE_DATABASE_URL')}
 if(users.length===2&&users[0]===users[1])errors.push('DATABASE_URL: SEPARATE_LOGINS_REQUIRED');
 if(e.MIGRATION_DATABASE_URL)errors.push('MIGRATION_DATABASE_URL: MUST_NOT_EXIST_IN_RUNTIME');
 try{const keys=JSON.parse(e.DRIVE_ENCRYPTION_KEYS??'{}');if(!keys||Array.isArray(keys)||!Object.hasOwn(keys,e.DRIVE_ACTIVE_KEY_ID??''))throw 0;for(const key of Object.values(keys))if(typeof key!=='string'||! /^[A-Za-z0-9+/]{43}=$/.test(key)||Buffer.from(key,'base64').length!==32)throw 0;}catch{errors.push('DRIVE_ENCRYPTION_KEYS: INVALID_KEY_RING')}
 const oauth=!!e.GOOGLE_OAUTH_CLIENT_ID&&!!e.GOOGLE_OAUTH_CLIENT_SECRET;let service=false;
 if(e.GOOGLE_SERVICE_ACCOUNT_JSON)try{const j=JSON.parse(e.GOOGLE_SERVICE_ACCOUNT_JSON);service=j.type==='service_account'&&typeof j.client_email==='string'&&typeof j.private_key==='string'&&j.private_key.includes('BEGIN PRIVATE KEY');if(!service)throw 0}catch{errors.push('GOOGLE_SERVICE_ACCOUNT_JSON: INVALID_FORMAT')}
 if(!oauth&&!service)errors.push('GOOGLE_DRIVE: OAUTH_OR_SERVICE_ACCOUNT_REQUIRED');
 if(!!e.GOOGLE_OAUTH_CLIENT_ID!==!!e.GOOGLE_OAUTH_CLIENT_SECRET)errors.push('GOOGLE_OAUTH: INCOMPLETE_PAIR');
 if(e.CENTRAL_SSO_TIMEOUT_MS&&(!/^\d+$/.test(e.CENTRAL_SSO_TIMEOUT_MS)||+e.CENTRAL_SSO_TIMEOUT_MS<1000||+e.CENTRAL_SSO_TIMEOUT_MS>60000))errors.push('CENTRAL_SSO_TIMEOUT_MS: INVALID_RANGE');
 if(e.DRIVE_MAX_UPLOAD_BYTES&&(!/^\d+$/.test(e.DRIVE_MAX_UPLOAD_BYTES)||+e.DRIVE_MAX_UPLOAD_BYTES<1||+e.DRIVE_MAX_UPLOAD_BYTES>104857600))errors.push('DRIVE_MAX_UPLOAD_BYTES: INVALID_RANGE');
 return {status:errors.length?'BLOCKED':'PASS',errors,scope:'Static configuration validation only; does not verify credentials, integrations or production readiness'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const r=checkEnvironment(process.env);console.log(JSON.stringify(r,null,2));if(r.errors.length)process.exitCode=1}
