import {UUID_RE, validHost, authBytes, equal} from './protocol.mjs';
import {bridge} from './bridge.mjs';
import {refresh, readPools, SOURCES} from './preferred.mjs';
import {provider, profile} from './subscription.mjs';
const encoder = new TextEncoder();
const HEADERS = {'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
function reply(body, status = 200, headers = {}) { return new Response(body, {status, headers: {...HEADERS, ...headers}}); }
export function validConfig(env) {
  const port = Number(env.UPSTREAM_PORT);
  const upstream = validHost(env.UPSTREAM_HOST) || /^[0-9a-f]*:[0-9a-f:]+$/i.test(env.UPSTREAM_HOST || '');
  if (!validHost(env.PUBLIC_HOST) || !upstream || !Number.isInteger(port) || port < 1 || port > 65535 || port === 25 ||
      !UUID_RE.test(env.UUID || '') || !/^[a-zA-Z0-9_-]{43,128}$/.test(env.SUB_TOKEN || '') ||
      !['true','false'].includes(env.UPSTREAM_TLS) || !(env.CARRIER === 'all' || Object.hasOwn(SOURCES, env.CARRIER))) return false;
  try { if (env.UPSTREAM_USER || env.UPSTREAM_PASS) authBytes(env.UPSTREAM_USER, env.UPSTREAM_PASS); } catch { return false; }
  return true;
}
export function createHandler(connect) {
  return {
    async fetch(request, env, ctx) {
      if (!validConfig(env)) return reply('Service not configured', 503);
      const url = new URL(request.url);
      if (url.hostname !== env.PUBLIC_HOST || request.method !== 'GET') return reply('Not found', 404);
      if (url.pathname === '/tunnel') {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return reply('WebSocket required', 426);
        // No early-data or multiplex support. UUID authentication happens before TCP dial.
        if (request.headers.get('sec-websocket-protocol')) return reply('Unsupported protocol', 400);
        const pair = new WebSocketPair(), [client, server] = Object.values(pair);
        server.accept(); bridge(server, env, connect);
        return new Response(null, {status: 101, webSocket: client});
      }
      const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/(Cloudflare-SOCKS5\.yaml|proxies\.yaml|status)$/);
      if (!match || !equal(encoder.encode(match[1]), encoder.encode(env.SUB_TOKEN))) return reply('Not found', 404);
      if (match[2] === 'Cloudflare-SOCKS5.yaml') return reply(profile(env), 200, {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Cloudflare-SOCKS5.yaml"',
        'Profile-Title': 'Cloudflare SOCKS5',
      });
      let pools = await readPools(env);
      if (!pools.some(p => p.entries.length)) {
        await refresh(env); pools = await readPools(env);
      }
      if (match[2] === 'status') return reply(JSON.stringify({
        refreshMinutes: 30, probeMinutes: 5, configuredKV: Boolean(env.PREFERRED),
        pools: pools.map(p => ({carrier: p.carrier, updatedAt: p.updatedAt, count: p.entries.length,
          stale: !p.updatedAt || Date.now() - p.updatedAt > 3600000})),
      }), 200, {'Content-Type': 'application/json'});
      return reply(provider(env, pools), 200, {'Content-Type': 'application/yaml; charset=utf-8'});
    },
    async scheduled(_event, env, ctx) { ctx.waitUntil(refresh(env)); },
  };
}
