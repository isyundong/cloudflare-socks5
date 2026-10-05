import {createInterface} from 'node:readline/promises';
import {readFile, writeFile} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {validHost} from '../src/protocol.mjs';
const rl = createInterface({input: process.stdin, output: process.stdout});
async function ask(label, fallback = '') { return (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; }
try {
  for (const path of ['wrangler.local.jsonc', 'secrets.local.json', 'subscription.local.txt']) {
    try { await readFile(path); throw new Error(`${path} 已存在；向导不会覆盖现有配置或凭据。`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log('\nCloudflare SOCKS5 · 部署准备\n本步骤只写本地配置，不部署、不改 DNS。\n');
  const name = await ask('Worker 名称', 'cloudflare-socks5');
  const host = (await ask('你自己的 Worker 域名，如 proxy.example.com')).toLowerCase();
  const upstream = await ask('已有 SOCKS5 的公网 IP 或域名（不能是 CF 橙云地址）');
  const port = await ask('已有 SOCKS5 端口', '1080');
  const tls = await ask('上游是否明确支持 SOCKS over TLS？true / false', 'false');
  const carrier = await ask('优选来源 all / ct=电信 / cu=联通 / cmcc=移动', 'all');
  const kv = await ask('PREFERRED KV 命名空间 ID（先运行 npx wrangler kv namespace create PREFERRED）');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || !validHost(host) || !host.includes('.') ||
      !(validHost(upstream) || /^[0-9a-f]*:[0-9a-f:]+$/i.test(upstream)) ||
      !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 || Number(port) === 25 ||
      !['true','false'].includes(tls) || !['all','ct','cu','cmcc'].includes(carrier) || !/^[a-f0-9]{32}$/i.test(kv)) throw new Error('输入格式不正确；未生成文件。');
  const config = JSON.parse(await readFile('wrangler.example.jsonc', 'utf8'));
  config.name = name;
  config.vars = {PUBLIC_HOST: host, UPSTREAM_HOST: upstream, UPSTREAM_PORT: port, UPSTREAM_TLS: tls, CARRIER: carrier};
  config.routes = [{pattern: host, custom_domain: true}];
  config.kv_namespaces = [{binding: 'PREFERRED', id: kv}];
  const secrets = {UUID: randomUUID(), SUB_TOKEN: randomBytes(32).toString('base64url')};
  await writeFile('wrangler.local.jsonc', JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await writeFile('secrets.local.json', JSON.stringify(secrets, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await writeFile('subscription.local.txt', `https://${host}/s/${secrets.SUB_TOKEN}/Cloudflare-SOCKS5.yaml\n`, {mode: 0o600, flag: 'wx'});
  console.log('\n准备完成。配置和新生成的凭据已存入被 Git 忽略的本地文件。');
  console.log('1. npm run deploy');
  console.log('2. npx wrangler secret bulk secrets.local.json --config wrangler.local.jsonc');
  console.log('3. 上游有账号密码时，用 wrangler secret put 分别填写 UPSTREAM_USER、UPSTREAM_PASS（README 有命令）。');
  console.log('4. 将 subscription.local.txt 中的地址导入 Mihomo 客户端。');
  if (tls === 'false') console.log('\n当前上游使用普通 SOCKS5：Worker 到上游这一段不额外加密；HTTPS 网站自身的 TLS 仍有效。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rl.close(); }
