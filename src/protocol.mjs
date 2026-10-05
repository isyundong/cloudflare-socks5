const encoder = new TextEncoder();
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function join(a, b) {
  const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
}
export function uuidBytes(uuid) {
  if (!UUID_RE.test(uuid || '')) throw new Error('Invalid UUID');
  return Uint8Array.from(uuid.replaceAll('-', '').match(/../g), x => parseInt(x, 16));
}
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0;
}
export function validHost(host) {
  return typeof host === 'string' && host.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}
// null means incomplete. Accept only VLESS v0 TCP without flow or multiplexing.
export function parseVless(data, uuid) {
  if (!data.length) return null;
  if (data[0] !== 0) throw new Error('Unsupported version');
  if (data.length < 18) return null;
  if (!equal(data.slice(1, 17), uuidBytes(uuid))) throw new Error('Unauthorized');
  if (data[17] !== 0) throw new Error('Unsupported addons');
  if (data.length < 22) return null;
  if (data[18] !== 1) throw new Error('Only TCP CONNECT is supported');
  const port = data[19] * 256 + data[20], kind = data[21];
  if (!port) throw new Error('Invalid port');
  let end, address;
  if (kind === 1) { end = 26; if (data.length < end) return null; address = data.slice(22, end); }
  else if (kind === 3) { end = 38; if (data.length < end) return null; address = data.slice(22, end); }
  else if (kind === 2) {
    if (data.length < 23) return null;
    end = 23 + data[22]; if (data.length < end) return null;
    const host = new TextDecoder('utf-8', {fatal: true}).decode(data.slice(23, end));
    if (!validHost(host)) throw new Error('Invalid destination');
    address = data.slice(22, end);
  } else throw new Error('Invalid address type');
  const socksKind = kind === 2 ? 3 : kind === 3 ? 4 : 1;
  return {request: join(join(new Uint8Array([5, 1, 0, socksKind]), address), data.slice(19, 21)), payload: data.slice(end), port};
}
export class ByteReader {
  constructor(reader) { this.reader = reader; this.buffer = new Uint8Array(); }
  async take(count) {
    while (this.buffer.length < count) {
      const {value, done} = await this.reader.read();
      if (done) throw new Error('Unexpected EOF');
      this.buffer = join(this.buffer, value);
      if (this.buffer.length > 1024 * 1024) throw new Error('Upstream handshake too large');
    }
    const result = this.buffer.slice(0, count); this.buffer = this.buffer.slice(count); return result;
  }
}
export function authBytes(username, password) {
  const user = encoder.encode(username || ''), pass = encoder.encode(password || '');
  if (!user.length || !pass.length || user.length > 255 || pass.length > 255) throw new Error('Invalid SOCKS5 credentials');
  return join(join(new Uint8Array([1, user.length]), user), join(new Uint8Array([pass.length]), pass));
}
export async function negotiate(reader, writer, request, username, password) {
  const auth = Boolean(username || password);
  const credentials = auth ? authBytes(username, password) : null;
  // When credentials were configured, require authentication; no silent downgrade.
  await writer.write(new Uint8Array([5, 1, auth ? 2 : 0]));
  const greeting = await reader.take(2);
  if (greeting[0] !== 5 || greeting[1] !== (auth ? 2 : 0)) throw new Error('SOCKS5 authentication method rejected');
  if (auth) {
    await writer.write(credentials);
    const result = await reader.take(2);
    if (result[0] !== 1 || result[1] !== 0) throw new Error('SOCKS5 authentication rejected');
  }
  await writer.write(request);
  const reply = await reader.take(4);
  if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error('SOCKS5 CONNECT rejected');
  if (reply[3] === 1) await reader.take(6);
  else if (reply[3] === 4) await reader.take(18);
  else if (reply[3] === 3) { const len = (await reader.take(1))[0]; await reader.take(len + 2); }
  else throw new Error('Invalid SOCKS5 reply');
}
