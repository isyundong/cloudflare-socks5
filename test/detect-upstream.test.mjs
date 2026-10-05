import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {detectUpstream} from '../tools/detect-upstream.mjs';
async function listen(t, server) {
  const peers=new Set();server.on('connection',s=>{peers.add(s);s.on('close',()=>peers.delete(s));s.on('error',()=>{});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const s of peers)s.destroy();await new Promise(r=>server.close(r));});
  return server.address().port;
}
test('plain SOCKS5 detected after rejected TLS; only authentication-method greeting sent',async t=>{
  const greetings=[];const server=net.createServer(s=>s.once('data',b=>{
    if(b[0]!==5){s.destroy();return;}greetings.push([...b]);s.write(Buffer.from([5]));setTimeout(()=>s.end(Buffer.from([2])),10);
  }));
  const port=await listen(t,server);const result=await detectUpstream({host:'127.0.0.1',port,auth:true,timeoutMs:500});
  assert.deepEqual(result,{mode:'plain',authRejected:false});assert.deepEqual(greetings,[[5,1,2]]);
});
test('silent endpoint and HTTP service are inconclusive, never silently plaintext',async t=>{
  const silent=await listen(t,net.createServer(()=>{}));
  assert.equal((await detectUpstream({host:'127.0.0.1',port:silent,timeoutMs:60})).mode,'unknown');
  const http=await listen(t,net.createServer(s=>s.once('data',()=>s.end('HTTP/1.1 400 Bad Request\r\n\r\n'))));
  assert.equal((await detectUpstream({host:'127.0.0.1',port:http,timeoutMs:200})).mode,'unknown');
});
test('authentication-method rejection still identifies SOCKS5 and reports mismatch',async t=>{
  const port=await listen(t,net.createServer(s=>s.once('data',b=>b[0]===5?s.end(Buffer.from([5,255])):s.destroy())));
  assert.deepEqual(await detectUpstream({host:'127.0.0.1',port,timeoutMs:200}),{mode:'plain',authRejected:true});
});
test('verified TLS SOCKS5 detected; bad certificates and non-SOCKS TLS never downgrade',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cf-tls-probe-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(dir,'openssl.cnf'),'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
  const key=await readFile(join(dir,'key.pem')),cert=await readFile(join(dir,'cert.pem'));let connections=0,mode='socks';
  const server=tls.createServer({key,cert},s=>s.once('data',b=>{assert.deepEqual([...b],[5,1,0]);s.end(mode==='socks'?Buffer.from([5,0]):Buffer.from('HTTP'));}));
  server.on('connection',()=>connections++);server.on('tlsClientError',()=>{});
  const port=await listen(t,server);
  assert.equal((await detectUpstream({host:'127.0.0.1',port,ca:cert,timeoutMs:1000})).mode,'tls');
  let before=connections;
  assert.deepEqual(await detectUpstream({host:'127.0.0.1',port,timeoutMs:1000}),{mode:'unknown',reason:'certificate'});
  assert.equal(connections-before,1);
  mode='http';before=connections;
  assert.equal((await detectUpstream({host:'127.0.0.1',port,ca:cert,timeoutMs:1000})).mode,'unknown');
  assert.equal(connections-before,1);
});
