// Source format documented at https://cf.090227.xyz/#/api (checked 2026-10-06).
// Only public candidate requests are made. No subscription or upstream secrets.
export const SOURCES = Object.freeze({ct: '电信', cu: '联通', cmcc: '移动'});
export const MAX_AGE_MS = 7 * 86400000;
const RANGES = ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22',
  '141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20',
  '197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13',
  '104.24.0.0/14','172.64.0.0/13','131.0.72.0/22'];
// https://www.cloudflare.com/ips-v4/ -- deliberately excludes third-party relays.
function ipv4(value) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return null;
  const p = value.split('.').map(Number); if (p.some(x => x > 255)) return null;
  return p.reduce((a, x) => a * 256 + x, 0);
}
export function isCloudflareIP(value) {
  const n = ipv4(value); if (n === null) return false;
  return RANGES.some(range => { const [a, b] = range.split('/'), size = 2 ** (32 - Number(b)); return Math.floor(n / size) === Math.floor(ipv4(a) / size); });
}
export function parseList(text, carrier) {
  const seen = new Set(), entries = [];
  for (const line of text.split(/\r?\n/)) {
    const address = line.split('#')[0].trim();
    if (!isCloudflareIP(address) || seen.has(address)) continue;
    seen.add(address); entries.push({address, carrier});
    if (entries.length === 24) break;
  }
  return entries;
}
export async function fetchList(carrier, fetcher = fetch) {
  if (!Object.hasOwn(SOURCES, carrier)) throw new Error('Invalid carrier');
  const controller = new AbortController();
  let reader, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      reject(new Error('Source timeout'));
    }, 5000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(`https://cf.090227.xyz/${carrier}?ips=12`, {
        // Workers supports manual, not redirect:error. Reject 3xx below.
        signal: controller.signal, redirect: 'manual', credentials: 'omit',
        headers: {Accept: 'text/plain'},
      });
      if (!response.ok || Number(response.headers.get('content-length')) > 32768 || !response.body) throw new Error('Source unavailable');
      reader = response.body.getReader();
      let data = '', size = 0; const decoder = new TextDecoder();
      while (true) {
        const {value, done} = await reader.read(); if (done) break;
        size += value.length; if (size > 32768) throw new Error('Source too large');
        data += decoder.decode(value, {stream: true});
      }
      const entries = parseList(data + decoder.decode(), carrier);
      if (!entries.length) throw new Error('Source contains no acceptable candidates');
      return entries;
    })()]);
  } finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
}
export async function refresh(env, fetcher = fetch, now = Date.now()) {
  if (!env.PREFERRED) return [];
  return Promise.all(Object.keys(SOURCES).map(async carrier => {
    try {
      const entries = await fetchList(carrier, fetcher);
      await env.PREFERRED.put(`pool:${carrier}`, JSON.stringify({updatedAt: now, entries}));
      return {carrier, ok: true, count: entries.length, entries, updatedAt: now};
    } catch { return {carrier, ok: false}; } // Preserve the last successful pool on failure.
  }));
}
export async function readPools(env, now = Date.now()) {
  const carriers = env.CARRIER === 'all' ? Object.keys(SOURCES) : [env.CARRIER];
  return Promise.all(carriers.map(async carrier => {
    let record; try { record = await env.PREFERRED?.get(`pool:${carrier}`, 'json'); } catch {}
    const valid = Number.isFinite(record?.updatedAt) && record.updatedAt <= now && now - record.updatedAt < MAX_AGE_MS;
    const entries = valid && Array.isArray(record.entries) ? record.entries.filter(e => e?.carrier === carrier && isCloudflareIP(e.address)).slice(0, 24) : [];
    return {carrier, updatedAt: valid ? record.updatedAt : null, entries};
  }));
}
export function endpoints(host, pools) {
  // A domain stays a domain in the client. DNS resolves it again according to its TTL.
  const list = [{address: host, label: '自有域名'}, {address: 'cf.090227.xyz', label: '优选域名'}];
  for (const pool of pools) for (const e of pool.entries) list.push({address: e.address, label: SOURCES[e.carrier]});
  const seen = new Set();
  return list.filter(e => { if (seen.has(e.address)) return false; seen.add(e.address); return true; });
}
