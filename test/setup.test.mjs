import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,readFile,stat,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setup} from '../tools/setup.mjs';
const account={id:'b'.repeat(32),name:'Test account'};
async function fixture(t) {
  const cwd=await mkdtemp(join(tmpdir(),'cf-setup-'));
  await copyFile('wrangler.example.jsonc',join(cwd,'wrangler.example.jsonc'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const answers=['proxy.example.test','socks.example.test','1080','test-user','y'];
  const calls=[],logs=[],namespaces=[];let authenticated=false,failDeploy=false,failAfterCreate=false;
  const options={cwd,detect:async()=>({mode:'plain'}),ask:async()=>answers.shift(),hidden:async()=> 'private-test-password',log:x=>logs.push(x),run:async(args)=>{
    calls.push(args);
    if(args[0]==='whoami'){if(!authenticated)throw Error('logged out');return JSON.stringify({loggedIn:true,accounts:[account]});}
    if(args[0]==='login'){authenticated=true;return '';}
    if(args[0]==='kv'&&args[2]==='list')return JSON.stringify(namespaces);
    if(args[0]==='kv'&&args[2]==='create'){namespaces.push({title:args[3],id:'c'.repeat(32)});if(failAfterCreate){failAfterCreate=false;throw Error('lost response');}return '';}
    if(args[0]==='deploy'){if(failDeploy)throw Error('upload failed');return '';}
    throw Error('Unexpected command');
  }};
  return {cwd,options,answers,calls,logs,namespaces,setFailDeploy:v=>failDeploy=v,setFailCreate:v=>failAfterCreate=v};
}
test('wizard automates login, KV and atomic secrets deploy without exposing passwords in args/logs',async t=>{
  const f=await fixture(t);const url=await setup(f.options);
  assert.match(url,/^https:\/\/proxy.example.test\/s\/.+\/Cloudflare-SOCKS5.yaml$/);
  const config=JSON.parse(await readFile(join(f.cwd,'wrangler.local.jsonc')));
  assert.equal(config.account_id,account.id);assert.equal(config.kv_namespaces[0].id,'c'.repeat(32));
  assert(f.calls.some(a=>a[0]==='login'));assert(f.calls.some(a=>a[0]==='deploy'&&a.includes('--secrets-file')));
  assert(!JSON.stringify(f.calls).includes('private-test-password'));assert(!f.logs.join('').includes('private-test-password'));
  assert.equal(JSON.parse(await readFile(join(f.cwd,'secrets.local.json'))).UPSTREAM_PASS,'private-test-password');
  if(process.platform!=='win32')assert.equal((await stat(join(f.cwd,'secrets.local.json'))).mode&0o777,0o600);
});
test('failed deployment resumes without rotating secrets, recreating KV or logging in twice',async t=>{
  const f=await fixture(t);f.setFailDeploy(true);await assert.rejects(setup(f.options));
  const before=await readFile(join(f.cwd,'secrets.local.json'),'utf8');f.setFailDeploy(false);f.answers.push('y');await setup(f.options);
  assert.equal(await readFile(join(f.cwd,'secrets.local.json'),'utf8'),before);
  assert.equal(f.calls.filter(a=>a[0]==='kv'&&a[2]==='create').length,1);
  assert.equal(f.calls.filter(a=>a[0]==='login').length,1);
});
test('lost KV creation response is reconciled by title on retry',async t=>{
  const f=await fixture(t);f.setFailCreate(true);await assert.rejects(setup(f.options));
  f.answers.push('y');await setup(f.options);assert.equal(f.calls.filter(a=>a[0]==='kv'&&a[2]==='create').length,1);
});
test('cancel makes no cloud calls and saves no credentials',async t=>{
  const f=await fixture(t);f.answers[f.answers.length-1]='n';await setup(f.options);
  assert.deepEqual(f.calls,[]);assert.deepEqual(await readdir(f.cwd),['wrangler.example.jsonc']);
});
test('invalid input stops before cloud changes',async t=>{
  const f=await fixture(t);f.answers[2]='0';await assert.rejects(setup(f.options));assert.deepEqual(f.calls,[]);
});

test('verified TLS detection enables TLS without a manual question',async t=>{
  const f=await fixture(t);f.options.detect=async args=>{assert.deepEqual(Object.keys(args).sort(),['auth','host','port']);return {mode:'tls'};};
  await setup(f.options);assert.equal(JSON.parse(await readFile(join(f.cwd,'wrangler.local.jsonc'))).vars.UPSTREAM_TLS,'true');
});
test('inconclusive detection stops on empty answer instead of assuming plaintext',async t=>{
  const f=await fixture(t);f.options.detect=async()=>({mode:'unknown',reason:'certificate'});f.answers[4]='';
  await setup(f.options);assert.deepEqual(f.calls,[]);assert.deepEqual(await readdir(f.cwd),['wrangler.example.jsonc']);
});
