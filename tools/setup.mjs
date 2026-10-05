import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {readFile, writeFile, rename, chmod} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validHost, authBytes} from '../src/protocol.mjs';
import {validConfig} from '../src/handler.mjs';
import {detectUpstream} from './detect-upstream.mjs';
const CONFIG = 'wrangler.local.jsonc', SECRETS = 'secrets.local.json';
async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`无法读取 ${path}，请保留文件并检查格式。`); }
}
async function save(path, value) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await rename(temp, path); await chmod(path, 0o600);
}
export async function setup({cwd = process.cwd(), ask, hidden, log = console.log, run, detect = detectUpstream}) {
  const path = file => join(cwd, file);
  let config = await readJSON(path(CONFIG)), secrets = await readJSON(path(SECRETS));
  if (config && !secrets) throw new Error('缺少 secrets.local.json。请恢复原文件；不会自动生成新凭据覆盖线上配置。');
  if (!config && secrets) throw new Error('缺少 wrangler.local.jsonc。请恢复原文件，现有凭据已保留。');
  log('\nCloudflare SOCKS5 · 安装向导\nClash → CF 优选入口 → 你的 SOCKS5 → 目标网站\n');
  if (!config) {
    const host = (await ask('1. 你的订阅域名（如 proxy.example.com）')).trim().toLowerCase();
    const upstream = (await ask('2. SOCKS5 公网 IP 或域名')).trim();
    const port = await ask('3. SOCKS5 端口', '1080');
    const user = await ask('4. SOCKS5 用户名（无认证直接回车）');
    const pass = user ? await hidden('   SOCKS5 密码（隐藏输入）') : '';
    if (user) authBytes(user, pass);

    config = JSON.parse(await readFile(path('wrangler.example.jsonc'), 'utf8'));
    config.name = `cf-socks-${randomBytes(4).toString('hex')}`;
    config.vars = {PUBLIC_HOST: host, UPSTREAM_HOST: upstream, UPSTREAM_PORT: port, UPSTREAM_TLS: 'false', CARRIER: 'all'};
    config.routes = [{pattern: host, custom_domain: true}];
    secrets = {UUID: randomUUID(), SUB_TOKEN: randomBytes(32).toString('base64url'), ...(user ? {UPSTREAM_USER: user, UPSTREAM_PASS: pass} : {})};
    if (!host.includes('.') || !validHost(host) || !validConfig({...config.vars, ...secrets})) throw new Error('域名、端口或 SOCKS5 配置格式不正确，尚未部署。');
    log('正在自动检测 SOCKS5 连接方式（最多约 7 秒，不发送账号密码）…');
    const detected = await detect({host:upstream, port:Number(port), auth:Boolean(user)});
    if (detected.mode === 'tls' || detected.mode === 'plain') {
      config.vars.UPSTREAM_TLS = detected.mode === 'tls' ? 'true' : 'false';
      log(detected.mode === 'tls' ? '已检测：SOCKS over TLS，证书验证通过。' : '已检测：普通 SOCKS5。');
      if (detected.authRejected) log('上游拒绝了当前认证方式，请核对是否需要用户名密码；本次未验证密码。');
    } else {
      log(detected.reason === 'certificate'
        ? '检测到 TLS 证书错误，不能自动判断可用配置。请核对上游域名和证书，未关闭证书校验。'
        : '本机未能确认连接方式，可能是超时、白名单限制或该端口并非 SOCKS5。');
      const choice = await ask('手动指定：1=普通 SOCKS5，2=SOCKS over TLS，回车退出');
      if (!['1','2'].includes(choice)) { log('已退出，未部署。'); return; }
      config.vars.UPSTREAM_TLS = choice === '2' ? 'true' : 'false';
    }

  } else {
    if (!validConfig({...config.vars, ...secrets})) throw new Error('已有配置不完整，请检查本地配置和凭据；不会覆盖。');
    log('检测到已有配置，将继续部署并保留节点凭据和订阅地址。');
  }
  log(`\n订阅域名：${config.vars.PUBLIC_HOST}\nSOCKS5 上游：${config.vars.UPSTREAM_HOST}:${config.vars.UPSTREAM_PORT}\n优选：电信 / 联通 / 移动，自动更新`);
  if (config.vars.UPSTREAM_TLS === 'false') log('上游使用普通 SOCKS5，Worker 到上游这一段不额外加密。');
  if ((await ask('开始部署到你的 Cloudflare？', 'y')).toLowerCase() !== 'y') { log('已取消，未修改云端。'); return; }
  // Save before network calls so failed runs resume with the same credentials/name.
  await save(path(SECRETS), secrets); await save(path(CONFIG), config);
  log('\n[1/3] 检查 Cloudflare 登录…');
  let user;
  try { user = JSON.parse(await run(['whoami','--json'], true)); } catch {}
  if (!user?.loggedIn) {
    log('浏览器将打开 Cloudflare 授权页面，请完成登录。');
    await run(['login']); user = JSON.parse(await run(['whoami','--json'], true));
  }
  const accounts = user.accounts || [];
  if (!accounts.length) throw new Error('未找到可用 Cloudflare 账户。');
  if (config.account_id) {
    if (!accounts.some(a => a.id === config.account_id)) throw new Error('当前登录不属于原部署账户，请切换账户后重试。');
  } else {
    let selected = accounts[0];
    if (accounts.length > 1) {
      accounts.forEach((a,i) => log(`  ${i + 1}. ${a.name}`));
      selected = accounts[Number(await ask('选择域名所在账户', '1')) - 1];
      if (!selected) throw new Error('账户选择无效。');
    }
    config.account_id = selected.id; await save(path(CONFIG), config);
  }
  const args = ['--config', CONFIG];
  log('[2/3] 准备优选数据存储…');
  if (!config.kv_namespaces?.some(k => k.binding === 'PREFERRED' && /^[a-f0-9]{32}$/i.test(k.id))) {
    const title = `${config.name}-preferred`;
    // Reconcile creation after an interrupted run, instead of duplicating resources.
    let list = JSON.parse(await run(['kv','namespace','list',...args], true));
    let found = list.find(n => n.title === title);
    if (!found) {
      await run(['kv','namespace','create',title,'--update-config=false',...args]);
      list = JSON.parse(await run(['kv','namespace','list',...args], true));
      found = list.find(n => n.title === title);
    }
    if (!found || !/^[a-f0-9]{32}$/i.test(found.id)) throw new Error('KV 创建结果尚未确认，请稍后重新运行 npm start；配置已保留。');
    config.kv_namespaces = [...(config.kv_namespaces || []).filter(k => k.binding !== 'PREFERRED'), {binding:'PREFERRED',id:found.id}];
    await save(path(CONFIG), config);
  }
  log('[3/3] 部署 Worker、绑定域名并上传凭据…');
  await run(['deploy',...args,'--secrets-file',SECRETS]);
  const url = `https://${config.vars.PUBLIC_HOST}/s/${secrets.SUB_TOKEN}/Cloudflare-SOCKS5.yaml`;
  await save(path('subscription.local.txt'), `${url}\n`);
  log(`\n部署命令执行成功。将下面地址导入 Clash/Mihomo：\n\n${url}\n\n选择 PROXY → 自动优选。域名证书和定时任务可能还需等待生效。\n订阅地址已保存到 subscription.local.txt，请勿公开。`);
  return url;
}
function wrangler(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), ...args], {
      stdio: capture ? ['ignore','pipe','pipe'] : 'inherit',
      env: {...process.env, WRANGLER_SEND_METRICS:'false'},
    });
    let output = '';
    if (capture) { child.stdout.on('data', b => {output += b;}); child.stderr.on('data', () => {}); }
    child.on('error', () => reject(new Error('无法启动 Wrangler，请先运行 npm ci。')));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Cloudflare 步骤未完成（${args[0]}）。配置已保留，可重新运行 npm start。`)));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let muted = false;
  const output = new Writable({write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); }});
  output.isTTY = process.stdout.isTTY; output.columns = process.stdout.columns;
  const rl = createInterface({input:process.stdin, output, terminal:Boolean(process.stdin.isTTY && process.stdout.isTTY)});
  const ask = async (label, fallback = '') => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)) || fallback;
  const hidden = async label => {
    if (!process.stdin.isTTY) throw new Error('输入密码需要交互终端，请直接运行 npm start。');
    process.stdout.write(`${label}: `); muted = true;
    try { return await rl.question(''); } finally { muted = false; process.stdout.write('\n'); }
  };
  // Suspend this readline while Wrangler owns stdin (browser login/account prompts).
  const run = async (...args) => {
    const raw = process.stdin.isRaw; rl.pause();
    if (raw) process.stdin.setRawMode(false);
    try { return await wrangler(...args); }
    finally { if (raw) process.stdin.setRawMode(true); rl.resume(); }
  };
  try { await setup({ask,hidden,run}); }
  catch(e) { console.error(`\n${e.message}`); process.exitCode = 1; }
  finally { rl.close(); }
}
