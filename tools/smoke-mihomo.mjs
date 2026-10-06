// Optional native integration: node tools/smoke-mihomo.mjs /absolute/path/to/mihomo
// Everything stays on loopback, with synthetic credentials and a mock HTTP exit.
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import YAML from 'yaml';
import {profile} from '../src/subscription.mjs';
if(!process.argv[2]) throw Error('Usage: node tools/smoke-mihomo.mjs /path/to/mihomo');
const env={PUBLIC_HOST:'proxy.example.test',UPSTREAM_HOST:'127.0.0.1',UPSTREAM_TLS:'false',CARRIER:'all',UUID:'01234567-89ab-4cde-8123-456789abcdef',SUB_TOKEN:'A'.repeat(43)};
let child,mf,exitServer,dir;const peers=new Set();let confirmed=false;
try {
  exitServer=net.createServer(s=>{
    peers.add(s);s.on('close',()=>peers.delete(s));s.on('error',()=>{});
    let state=0,buf=Buffer.alloc(0);
    s.on('data',data=>{
      buf=Buffer.concat([buf,data]);
      if(state===0 && buf.length>=3){if(!buf.subarray(0,3).equals(Buffer.from([5,1,0])))return s.destroy();buf=buf.subarray(3);s.write(Buffer.from([5,0]));state=1;}
      if(state===1 && buf.length>=5){
        const n=buf[3]===3?7+buf[4]:buf[3]===1?10:22;if(buf.length<n)return;
        const target=buf[3]===3?buf.subarray(5,5+buf[4]).toString():'';
        if(target!=='example.test')return s.destroy();
        confirmed=true;buf=buf.subarray(n);s.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));state=2;
      }
      if(state===2 && buf.includes('\r\n\r\n')){
        const body='exit-via-socks';s.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);state=3;
      }
    });
  });
  exitServer.listen(0,'127.0.0.1');await once(exitServer,'listening');env.UPSTREAM_PORT=String(exitServer.address().port);
  mf=new Miniflare(convertV4MiniflareOptions({modules:['worker','handler','bridge','protocol','preferred','subscription'].map(n=>({type:'ESModule',path:`src/${n}.mjs`})),compatibilityDate:'2026-09-01',bindings:env}));
  const ready=await mf.ready;
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const localPort=reservation.address().port;await new Promise(r=>reservation.close(r));
  const config=YAML.parse(profile(env));config['mixed-port']=localPort;delete config['proxy-providers'];
  // Never modify host routes or DNS in this loopback-only transport test.
  config.tun.enable=false;config.dns.enable=false;
  // Test-only plaintext loopback transport. Production output requires TLS: true.
  config.proxies[0].server=ready.hostname;config.proxies[0].port=Number(ready.port);config.proxies[0].tls=false;
  config['proxy-groups']=[{name:'PROXY',type:'select',proxies:[config.proxies[0].name]}];
  dir=await mkdtemp(join(tmpdir(),'cf-socks-smoke-'));const file=join(dir,'config.yaml');await writeFile(file,YAML.stringify(config),{mode:0o600});
  child=spawn(process.argv[2],['-d',dir,'-f',file],{stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  await new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>{clearInterval(poll);reject(Error('Mihomo did not start: '+logs));},10000);
    const poll=setInterval(()=>{
      const s=net.connect(localPort,'127.0.0.1');s.once('connect',()=>{s.destroy();clearTimeout(deadline);clearInterval(poll);resolve();});s.on('error',()=>{});
    },100);
  });
  const output=await new Promise((resolve,reject)=>{
    const s=net.connect(localPort,'127.0.0.1');let stage=0,buf=Buffer.alloc(0),body='';s.setTimeout(10000,()=>s.destroy(Error('timeout')));s.on('error',reject);
    s.on('connect',()=>s.write(Buffer.from([5,1,0])));
    s.on('data',data=>{
      buf=Buffer.concat([buf,data]);
      if(stage===0&&buf.length>=2){if(buf[0]!==5||buf[1]!==0)return s.destroy(Error('SOCKS greeting'));buf=buf.subarray(2);const host=Buffer.from('example.test');s.write(Buffer.concat([Buffer.from([5,1,0,3,host.length]),host,Buffer.from([0,80])]));stage=1;}
      if(stage===1&&buf.length>=10){if(buf[1]!==0)return s.destroy(Error('SOCKS connect'));buf=buf.subarray(10);s.write('GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');stage=2;}
      if(stage===2){body+=buf.toString();buf=Buffer.alloc(0);if(body.endsWith('exit-via-socks')){resolve(body);s.destroy();}}
    });
    s.on('end',()=>{if(!body.endsWith('exit-via-socks'))reject(Error('incomplete HTTP response'));});
  });
  if(!confirmed||!output.includes('200 OK'))throw Error('Exit not verified');
  console.log('PASS: native Mihomo → workerd WebSocket → real TCP SOCKS5 fixture → mock HTTP target.');
} finally {
  if(child){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}
  if(mf)await mf.dispose();for(const s of peers)s.destroy();if(exitServer)await new Promise(r=>exitServer.close(r));if(dir)await rm(dir,{recursive:true,force:true});
}
