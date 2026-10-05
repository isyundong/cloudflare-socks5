import {join, parseVless, ByteReader, negotiate} from './protocol.mjs';
export const MAX_PENDING = 1024 * 1024;
// Each connection has an independent socket. Never dial destinations directly:
// all CONNECT requests go through the fixed administrator-configured upstream.
export function bridge(ws, env, connect) {
  ws.binaryType = 'arraybuffer';
  let socket, writer, reader, stopped = false, ready = false;
  let header = new Uint8Array(), pending = 0, chain = Promise.resolve();
  const close = (code = 1000) => {
    if (stopped) return; stopped = true; clearTimeout(deadline);
    try { ws.close(code, code === 1000 ? '' : 'Tunnel closed'); } catch {}
    try { if (socket) Promise.resolve(socket.close()).catch(() => {}); } catch {}
  };
  const deadline = setTimeout(() => close(1008), 15000);
  ws.addEventListener('close', () => close());
  ws.addEventListener('error', () => close(1011));
  async function download() {
    try {
      if (reader.buffer.length) ws.send(reader.buffer);
      while (!stopped) {
        const {value, done} = await reader.reader.read();
        if (done) break;
        // Avoid oversized WebSocket messages; no unbounded application read queue.
        for (let i = 0; i < value.length; i += 65536) ws.send(value.subarray(i, i + 65536));
      }
      close();
    } catch { close(1011); }
  }
  async function receive(data) {
    if (stopped) return;
    if (ready) { await writer.write(data); return; }
    header = join(header, data);
    const parsed = parseVless(header, env.UUID);
    if (!parsed) { if (header.length > 512) throw new Error('Invalid header'); return; }
    socket = connect({hostname: env.UPSTREAM_HOST, port: Number(env.UPSTREAM_PORT)}, {
      secureTransport: env.UPSTREAM_TLS === 'true' ? 'on' : 'off',
    });
    socket.closed.catch(() => close(1011));
    await socket.opened;
    if (stopped) return;
    writer = socket.writable.getWriter(); reader = new ByteReader(socket.readable.getReader());
    await negotiate(reader, writer, parsed.request, env.UPSTREAM_USER, env.UPSTREAM_PASS);
    if (stopped) return;
    ready = true; clearTimeout(deadline); header = null;
    ws.send(new Uint8Array([0, 0]));
    if (parsed.payload.length) await writer.write(parsed.payload);
    void download();
  }
  ws.addEventListener('message', event => {
    if (stopped) return;
    if (!(event.data instanceof ArrayBuffer)) { close(1003); return; }
    const data = new Uint8Array(event.data);
    pending += data.length;
    if (pending > MAX_PENDING) { close(1009); return; }
    chain = chain.then(() => receive(data)).catch(() => close(1011)).finally(() => { pending -= data.length; });
  });
  return close;
}
