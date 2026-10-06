import {test} from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {ByteReader, negotiate, parseVless, uuidBytes, join} from '../src/protocol.mjs';
import {parseList, refresh, readPools, fetchList, isCloudflareIP, MAX_AGE_MS} from '../src/preferred.mjs';
import {profile, provider} from '../src/subscription.mjs';
import {createHandler, validConfig} from '../src/handler.mjs';
export const env = {PUBLIC_HOST:'proxy.example.test',UPSTREAM_HOST:'socks.example.test',UPSTREAM_PORT:'1080',UPSTREAM_TLS:'false',CARRIER:'all',UUID:'01234567-89ab-4cde-8123-456789abcdef',SUB_TOKEN:'A'.repeat(43)};
function vless(kind, address, tail = []) { return join(join(new Uint8Array([0, ...uuidBytes(env.UUID), 0, 1, 1, 187, kind]), new Uint8Array(address)), new Uint8Array(tail)); }
function kv() { const map = new Map(); return {get:async k => JSON.parse(map.get(k) || 'null'),put:async(k,v)=>map.set(k,v)}; }
test('VLESS fragmented header waits; preserves early payload and domain', () => {
  const msg = vless(2, [11, ...new TextEncoder().encode('example.com')], [10,20]);
  for (let i=0;i<msg.length-2;i++) assert.equal(parseVless(msg.slice(0,i), env.UUID),null);
  const out=parseVless(msg,env.UUID); assert.equal(out.port,443); assert.deepEqual([...out.payload],[10,20]);
  assert.deepEqual([...out.request.slice(0,5)],[5,1,0,3,11]);
});
test('VLESS IPv4 and IPv6 address types map to SOCKS5', () => {
  assert.equal(parseVless(vless(1,[1,2,3,4]),env.UUID).request[3],1);
  assert.equal(parseVless(vless(3,Array(16).fill(1)),env.UUID).request[3],4);
});
test('VLESS rejects wrong credential, UDP, mux, invalid version and empty domain', () => {
  for (const [index,value] of [[0,1],[1,99],[17,1],[18,2],[18,3],[21,9]]) {
    const m=vless(1,[1,2,3,4]);m[index]=value;assert.throws(()=>parseVless(m,env.UUID));
  }
  assert.throws(()=>parseVless(vless(2,[0]),env.UUID));
});
function byteReader(bytes) { return new ByteReader(new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}}).getReader()); }
test('SOCKS handshake handles fragmented auth and IPv6 reply without dropping first data', async () => {
  const writes=[];const reader=byteReader([5,2,1,0,5,0,0,4,...Array(18).fill(0),99]);
  await negotiate(reader,{write:async b=>writes.push([...b])},new Uint8Array([5,1,0,1,1,2,3,4,1,187]),'user','pass');
  assert.deepEqual(writes[0],[5,1,2]);assert.deepEqual(writes[1],[1,4,117,115,101,114,4,112,97,115,115]);
  assert.equal((await reader.take(1))[0],99);
});
test('SOCKS no-auth with domain bind reply', async()=> {
  await negotiate(byteReader([5,0,5,0,0,3,1,97,0,80]),{write:async()=>{}},new Uint8Array());
});
test('SOCKS rejects downgrade, auth failure and CONNECT failure', async()=> {
  for(const reply of [[5,0],[5,2,1,1],[5,2,1,0,5,5,0,1]]) {
    await assert.rejects(negotiate(byteReader(reply),{write:async()=>{}},new Uint8Array(),'u','p'));
  }
});
test('SOCKS rejects half credentials and oversized credentials', async()=> {
  for(const [u,p] of [['u',''],['','p'],['x'.repeat(256),'p']]) await assert.rejects(negotiate(byteReader([]),{write:async()=>{}},new Uint8Array(),u,p));
});
test('public source parser deduplicates and excludes private and non-CF relay IPs',()=> {
  assert.deepEqual(parseList('104.17.1.1#label\n104.17.1.1\n127.0.0.1\n8.35.211.4\n<script>\n104.17.2.2','ct'),[{address:'104.17.1.1',carrier:'ct'},{address:'104.17.2.2',carrier:'ct'}]);
  assert.equal(isCloudflareIP('999.1.1.1'),false);assert.equal(isCloudflareIP('104.16.0.1'),true);
});
test('fixed public fetch sends no credentials, rejects redirects and excessive bodies', async()=> {
  let called; await fetchList('ct', async(url,options)=>{called={url,options};return new Response('104.17.1.1#entry');});
  assert.equal(called.url,'https://cf.090227.xyz/ct?ips=12');assert.deepEqual(called.options.headers,{Accept:'text/plain'});
  assert.equal(called.options.redirect,'manual');assert.equal(called.options.credentials,'omit');
  await assert.rejects(fetchList('other',()=>{}));
  await assert.rejects(fetchList('ct',async()=>new Response('x'.repeat(32769))));
  await assert.rejects(fetchList('ct',async()=>new Response('104.17.1.1',{status:302})));
});
test('refresh preserves last successful pool on source failure, expires after seven days',async()=> {
  const e={...env,PREFERRED:kv()},now=Date.now();
  await refresh(e,async()=>new Response('104.17.1.1'),now);
  await refresh(e,async()=>{throw Error('offline');},now+10000);
  assert.equal((await readPools(e,now+10000))[0].entries.length,1);
  assert.equal((await readPools(e,now+MAX_AGE_MS))[0].entries.length,0);
});
test('partial source failure does not erase other carriers',async()=> {
  const e={...env,PREFERRED:kv()};const result=await refresh(e,async(url)=>url.includes('/cu?')?new Response('',{status:503}):new Response('104.17.1.1'));
  assert.deepEqual(result.map(x=>x.ok),[true,false,true]);
});
test('profile refreshes provider and checks entire proxy path; no DIRECT traffic fallback',()=> {
  const c=YAML.parse(profile(env));assert.equal(c['mixed-port'],7890);assert.equal(c['allow-lan'],false);
  assert.equal(c['proxy-providers']['CF入口'].interval,1800);
  assert.equal(c['proxy-providers']['CF入口']['health-check'].interval,300);
  assert.equal(c['proxy-groups'][1].tolerance,80);assert.deepEqual(c.rules,['MATCH,PROXY']);
  assert(c['proxy-groups'].every(g=>!g.proxies.includes('DIRECT')));assert.equal(c.proxies[0]['skip-cert-verify'],false);
});
test('provider changes only entry server; upstream credentials never appear in YAML',()=> {
  const e={...env,UPSTREAM_USER:'sensitive-user',UPSTREAM_PASS:'sensitive-pass'};
  const text=provider(e,[{entries:[{address:'104.17.1.1',carrier:'ct'}]}]);const c=YAML.parse(text);
  assert.equal(c.proxies.length,3);assert(c.proxies.every(p=>p.servername===env.PUBLIC_HOST && p['ws-opts'].headers.Host===env.PUBLIC_HOST && p.udp===false));
  for(const secret of [e.UPSTREAM_HOST,e.UPSTREAM_USER,e.UPSTREAM_PASS]) assert(!text.includes(secret));
});
test('routes require configured host and private subscription token',async()=> {
  const handler=createHandler(()=>{throw Error('must not dial');});
  for(const path of ['/', '/s/bad/proxies.yaml','/s/'+env.SUB_TOKEN+'/other']) assert.equal((await handler.fetch(new Request('https://'+env.PUBLIC_HOST+path),env,{})).status,404);
  const good=await handler.fetch(new Request(`https://${env.PUBLIC_HOST}/s/${env.SUB_TOKEN}/Cloudflare-SOCKS5.yaml`),env,{});
  assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'private, no-store');
  assert.equal((await handler.fetch(new Request(`https://wrong.example/s/${env.SUB_TOKEN}/Cloudflare-SOCKS5.yaml`),env,{})).status,404);
});
test('configuration fails closed for missing token/UUID, invalid port, and partial credentials',()=> {
  assert(validConfig(env));
  for(const bad of [{SUB_TOKEN:''},{UUID:''},{UPSTREAM_PORT:'0'},{UPSTREAM_PORT:'25'},{UPSTREAM_PORT:'abc'},{UPSTREAM_USER:'u'},{CARRIER:'wrong'},{PUBLIC_HOST:'bad/host'}]) assert.equal(validConfig({...env,...bad}),false);
});
test('stalled public body times out and aborts without discarding last-good data', {timeout:8000}, async()=> {
  let signal;const start=Date.now();
  await assert.rejects(fetchList('ct',async(_url,opts)=>{signal=opts.signal;return new Response(new ReadableStream({start(){}}));}));
  assert(signal.aborted);assert(Date.now()-start<7000);
});
test('corrupt cache entries cannot become nodes or crash the provider',async()=> {
  const now=Date.now();const e={...env,PREFERRED:kv()};await e.PREFERRED.put('pool:ct',JSON.stringify({updatedAt:now,entries:[null,{}, {carrier:'ct',address:'127.0.0.1'},{carrier:'ct',address:'104.17.1.1'}]}));
  assert.equal((await readPools(e,now))[0].entries.length,1);
});

test('first provider response uses fetched IPs even when KV caches a missing key',async t=>{
  const writes=[];const e={...env,PREFERRED:{get:async()=>null,put:async(...args)=>writes.push(args)}};
  t.mock.method(globalThis,'fetch',async()=>new Response('104.17.1.1#source'));
  const response=await createHandler(()=>{}).fetch(new Request(`https://${env.PUBLIC_HOST}/s/${env.SUB_TOKEN}/proxies.yaml`),e,{});
  const content=YAML.parse(await response.text());assert(content.proxies.some(p=>p.server==='104.17.1.1'));assert.equal(writes.length,3);
});
