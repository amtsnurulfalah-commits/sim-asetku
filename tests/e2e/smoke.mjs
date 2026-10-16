import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,chmod} from 'node:fs/promises';
import {brotliDecompressSync} from 'node:zlib';
import {chromium} from 'playwright-core';
import path from 'node:path';
import net from 'node:net';
const results=[];let browser,server;
console.log('Preparing browser smoke');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const origin=`http://127.0.0.1:${port}`;
try{
 await mkdir('tmp/browser',{recursive:true});const binary=path.resolve(await mkdtemp('tmp/browser/run-'),'chromium');
 await writeFile(binary,brotliDecompressSync(await readFile('node_modules/@sparticuz/chromium/bin/chromium.br')));await chmod(binary,0o755);
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NODE_ENV:'production'},stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/login')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,200))}assert.ok(ready,'Production server ready');
 browser=await chromium.launch({executablePath:binary,headless:true,timeout:20000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});const page=await browser.newPage();page.setDefaultTimeout(10000);
 async function check(name,fn){console.log('RUN',name);try{await fn();results.push({name,status:'PASS'})}catch(e){results.push({name,status:'FAIL',error:e.message})}}
 await check('Production login page and defensive headers',async()=>{const r=await page.goto(origin+'/login');assert.equal(r.status(),200);assert.equal(r.headers()['x-frame-options'],'DENY');assert.equal(r.headers()['x-content-type-options'],'nosniff');await page.getByRole('heading',{name:'Masuk ke ruang kerja'}).waitFor()});
 await check('Password visibility toggle',async()=>{await page.getByLabel('Password',{exact:true}).fill('local-fixture-only');await page.getByRole('button',{name:'Tampilkan password'}).click();assert.equal(await page.locator('#password').getAttribute('type'),'text');await page.getByRole('button',{name:'Sembunyikan password'}).click();assert.equal(await page.locator('#password').getAttribute('type'),'password')});
 await check('Dashboard fails closed when service configuration is absent',async()=>{await page.goto(origin+'/dashboard');await page.getByRole('heading',{name:'Halaman belum dapat dimuat'}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes('ASET-001'))});
 await check('Mobile login form remains usable',async()=>{await page.setViewportSize({width:390,height:844});await page.goto(origin+'/login');await page.getByLabel('Username',{exact:true}).fill('test.viewer');assert.equal(await page.locator('#username').inputValue(),'test.viewer');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)});
 await check('Missing service configuration fails closed without echoing password',async()=>{await page.locator('#password').fill('private-fixture-no-echo');const reply=page.waitForResponse(r=>r.url().endsWith('/api/auth/csrf'));await page.locator('button[type=submit]').click();const r=await reply;assert.equal(r.status(),503);await page.locator('form [role=alert]').waitFor();await page.waitForFunction(()=>document.querySelector('#password')?.value==='');assert.ok(!(await page.locator('body').innerText()).includes('private-fixture-no-echo'))});
 const report={engine:await browser.version(),scope:'Production Next.js browser smoke, anonymous and fail-closed paths only; no SSO/database connection',passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results,authenticated_e2e:'NOT_RUN: local SSO HTTPS harness must be restored and repaired',production_ready:false};
 await writeFile('docs/VERIFICATION-E2E-Stage12.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
}finally{await browser?.close();if(server){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r))}}
