import {endpoints} from './preferred.mjs';
function yaml(value, depth = 0) {
  const indent = ' '.repeat(depth);
  if (Array.isArray(value)) return value.map(v => {
    if (typeof v === 'object' && v !== null) {
      const [first, ...rest] = yaml(v, depth + 2).split('\n');
      return `${indent}- ${first.slice(depth + 2)}${rest.length ? '\n' + rest.join('\n') : ''}`;
    }
    return `${indent}- ${JSON.stringify(v)}`;
  }).join('\n');
  return Object.entries(value).map(([key, v]) => typeof v === 'object' && v !== null
    ? `${indent}${key}:\n${yaml(v, depth + 2)}` : `${indent}${key}: ${JSON.stringify(v)}`).join('\n');
}
export function nodes(env, pools) {
  return endpoints(env.PUBLIC_HOST, pools).map(e => ({
    name: `${e.label} · ${e.address}`, type: 'vless', server: e.address, port: 443,
    uuid: env.UUID, tls: true, udp: false, network: 'ws', servername: env.PUBLIC_HOST,
    'skip-cert-verify': false, 'client-fingerprint': 'chrome',
    'ws-opts': {path: '/tunnel', headers: {Host: env.PUBLIC_HOST}},
  }));
}
export function provider(env, pools) { return yaml({proxies: nodes(env, pools)}) + '\n'; }
export function profile(env) {
  // A bootstrap proxy keeps provider failures from turning an empty group into DIRECT.
  const fallback = nodes(env, [])[0]; fallback.name = '自有域名 · 备用';
  return yaml({
    'mixed-port': 7890, 'allow-lan': false, 'bind-address': '127.0.0.1',
    mode: 'rule', 'log-level': 'warning', ipv6: false,
    proxies: [fallback],
    'proxy-providers': {'CF入口': {
      type: 'http', url: `https://${env.PUBLIC_HOST}/s/${env.SUB_TOKEN}/proxies.yaml`,
      interval: 1800, proxy: 'DIRECT', 'size-limit': 262144,
      'health-check': {enable: true, url: 'https://www.gstatic.com/generate_204', interval: 300, timeout: 5000, lazy: false},
    }},
    'proxy-groups': [
      {name: 'PROXY', type: 'select', proxies: ['自动优选', fallback.name], use: ['CF入口']},
      {name: '自动优选', type: 'url-test', proxies: [fallback.name], use: ['CF入口'],
        url: 'https://www.gstatic.com/generate_204', interval: 300, tolerance: 80, lazy: false},
    ],
    rules: ['MATCH,PROXY'],
  }) + '\n';
}
