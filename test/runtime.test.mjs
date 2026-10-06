import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {uuidBytes} from '../src/protocol.mjs';
const UUID='01234567-89ab-4cde-8123-456789abcdef';
test('workerd bridges real TCP SOCKS5 handshake and bidirectional data', {timeout:20000}, async t=>{
  let accepted=0;const peers=new Set();
  const server=net.createServer(socket=>{
    peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
    let step=0;let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(step===0 && buffer.length>=3){assert.deepEqual([...buffer.subarray(0,3)],[5,1,0]);buffer=buffer.subarray(3);socket.write(Buffer.from([5,0]));step=1;}
      if(step===1 && buffer.length>=10){assert.deepEqual([...buffer.subarray(0,10)],[5,1,0,1,1,2,3,4,1,187]);buffer=buffer.subarray(10);socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));step=2;accepted++;}
      if(step===2 && buffer.length){socket.write(buffer);buffer=Buffer.alloc(0);}
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const peer of peers)peer.destroy();await new Promise(r=>server.close(r));});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker','handler','bridge','protocol','preferred','subscription'].map(name=>({type:'ESModule',path:`src/${name}.mjs`})),compatibilityDate:'2026-09-01',
    bindings:{PUBLIC_HOST:'proxy.example.test',UPSTREAM_HOST:'127.0.0.1',UPSTREAM_PORT:String(server.address().port),UPSTREAM_TLS:'false',CARRIER:'all',UUID,SUB_TOKEN:'A'.repeat(43)},kvNamespaces:['PREFERRED']}));
  t.after(()=>mf.dispose());
  const response=await mf.dispatchFetch('https://proxy.example.test/tunnel',{headers:{Upgrade:'websocket'}});
  assert.equal(response.status,101);const ws=response.webSocket;ws.accept();
  const chunks=[];
  const received=new Promise((resolve,reject)=>{
    ws.addEventListener('message',e=>{chunks.push(new Uint8Array(e.data));if(chunks.reduce((a,b)=>a+b.length,0)>=7)resolve();});
    ws.addEventListener('error',()=>reject(Error('WebSocket failed')));
    ws.addEventListener('close',e=>reject(Error(`Closed before echo: ${e.code}; accepted=${accepted}`)));
  });
  ws.send(new Uint8Array([0,...uuidBytes(UUID),0,1,1,187,1,1,2,3,4,72,69,76,76,79]));
  await received;
  assert.deepEqual(chunks.flatMap(x=>[...x]),[0,0,72,69,76,76,79]);assert.equal(accepted,1);ws.close();
});

test('workerd accepts public source fetch options and rejects redirects without following them',async t=>{
  let redirect=false;const calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({modules:[
    {type:'ESModule',path:'source-probe.mjs',contents:`import {fetchList} from './src/preferred.mjs';export default {async fetch(){try{return Response.json(await fetchList('ct'));}catch{return new Response('rejected',{status:502});}}}`},
    {type:'ESModule',path:'src/preferred.mjs'},
  ],compatibilityDate:'2026-09-01',outboundService:request=>{
    calls.push(request.url);
    return redirect?new Response(null,{status:302,headers:{Location:'https://untrusted.example/'}}):new Response('104.17.1.1#source');
  }}));t.after(()=>mf.dispose());
  const success=await mf.dispatchFetch('http://localhost/');assert.equal(success.status,200);assert.equal((await success.json())[0].address,'104.17.1.1');
  redirect=true;assert.equal((await mf.dispatchFetch('http://localhost/')).status,502);
  assert.deepEqual(calls,['https://cf.090227.xyz/ct?ips=12','https://cf.090227.xyz/ct?ips=12']);
});
