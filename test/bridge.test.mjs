import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridge, MAX_PENDING} from '../src/bridge.mjs';
import {uuidBytes} from '../src/protocol.mjs';
const UUID='01234567-89ab-4cde-8123-456789abcdef';
class WS extends EventTarget {
  sent=[];closed=[];
  send(data){this.sent.push([...data]);}
  close(code){this.closed.push(code);}
  message(data){this.dispatchEvent(new MessageEvent('message',{data}));}
}
const tick=()=>new Promise(r=>setTimeout(r,15));
test('unauthorized VLESS never opens upstream socket',async()=>{
  let calls=0;const ws=new WS();const close=bridge(ws,{UUID},()=>{calls++;});
  ws.message(new Uint8Array([0,...Array(16).fill(0),0,1,1,187,1,1,2,3,4]).buffer);
  await tick();assert.equal(calls,0);assert.deepEqual(ws.closed,[1011]);close();
});
test('nonbinary and excess pending input close bounded connection',()=>{
  for(const data of ['bad',new ArrayBuffer(MAX_PENDING+1)]){
    const ws=new WS();bridge(ws,{UUID},()=>{});ws.message(data);assert.equal(ws.closed.length,1);
  }
});
test('bridge uses fixed upstream, waits SOCKS ack, keeps pipelined payload in order and cleans up',async()=>{
  const ws=new WS(),writes=[];let args,control,closed=0;
  const socket={opened:Promise.resolve(),closed:new Promise(()=>{}),
    writable:new WritableStream({write(data){writes.push([...data]);if(writes.length===1)control.enqueue(new Uint8Array([5,0]));if(writes.length===2)control.enqueue(new Uint8Array([5,0,0,1,0,0,0,0,0,0,90]));}}),
    readable:new ReadableStream({start(c){control=c;}}),close:async()=>{closed++;}};
  const stop=bridge(ws,{UUID,UPSTREAM_HOST:'fixed.example',UPSTREAM_PORT:'1080',UPSTREAM_TLS:'true'},(...a)=>{args=a;return socket;});
  const input=new Uint8Array([0,...uuidBytes(UUID),0,1,1,187,1,1,2,3,4,80,81]);
  ws.message(input.slice(0,10).buffer);ws.message(input.slice(10).buffer);ws.message(new Uint8Array([82]).buffer);
  await tick();assert.deepEqual(args,[{hostname:'fixed.example',port:1080},{secureTransport:'on'}]);
  assert.deepEqual(writes.slice(2),[[80,81],[82]]);assert.deepEqual(ws.sent,[[0,0],[90]]);
  stop();assert.equal(closed,1);
});
