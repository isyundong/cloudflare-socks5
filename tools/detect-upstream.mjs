import net from 'node:net';
import tls from 'node:tls';
const CERT_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|TLS_CERT/;
// Only the SOCKS5 method greeting is sent; no username, password or CONNECT.
function probe({host, port, auth, timeoutMs, ca}, encrypted) {
  return new Promise(resolve => {
    let socket, timer, finished = false, received = Buffer.alloc(0), secure = false;
    const finish = result => {
      if (finished) return; finished = true; clearTimeout(timer); socket?.destroy(); resolve(result);
    };
    const greeting = () => socket.write(Buffer.from([5, 1, auth ? 2 : 0]));
    timer = setTimeout(() => finish({ok:false, reason:'timeout', secure}), timeoutMs);
    try {
      socket = encrypted
        ? tls.connect({host, port, servername:net.isIP(host) ? undefined : host, rejectUnauthorized:true, ...(ca ? {ca} : {})})
        : net.connect({host, port});
      socket.once(encrypted ? 'secureConnect' : 'connect', () => { secure = encrypted; greeting(); });
      socket.on('data', chunk => {
        received = Buffer.concat([received, chunk.subarray(0, 2 - received.length)]);
        if (received.length < 2) return;
        const ok = received[0] === 5 && [auth ? 2 : 0, 255].includes(received[1]);
        finish({ok, secure, reason:ok ? undefined : 'not-socks5', authRejected:received[1] === 255});
      });
      socket.once('error', error => finish({ok:false, secure, reason:CERT_ERROR.test(error.code || '') ? 'certificate' : 'connection'}));
      socket.once('close', () => finish({ok:false, secure, reason:'closed'}));
    } catch { finish({ok:false, secure, reason:'connection'}); }
  });
}
export async function detectUpstream({host, port, auth = false, timeoutMs = 3500, ca}) {
  const options = {host, port:Number(port), auth, timeoutMs, ca};
  const encrypted = await probe(options, true);
  if (encrypted.ok) return {mode:'tls', authRejected:encrypted.authRejected};
  // A bad certificate or a verified TLS service is not evidence of plaintext SOCKS.
  // Never automatically downgrade these cases.
  if (encrypted.reason === 'certificate' || encrypted.secure) return {mode:'unknown', reason:encrypted.reason};
  const plain = await probe(options, false);
  if (plain.ok) return {mode:'plain', authRejected:plain.authRejected};
  return {mode:'unknown', reason:'unreachable-or-not-socks5'};
}
