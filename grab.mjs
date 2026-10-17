// Botkeep 免费机器抢购脚本 (Node.js 20+) —— 改版：多账号 + 节点黑名单/白名单
// 流程（每个账号独立）：登录 -> 查已有服务器 -> 轮询容量 -> 有容量立即创建
//   -> 白名单模式：落点不在白名单 → 删除、TG 通知、暂停后继续抢
//   -> 黑名单模式：落点在黑名单 → 删除、TG 通知、暂停后继续抢
//   -> 否则：TG 通知抢到，本账号结束
// 访问 Botkeep 的请求会走 PROXY_URL（由工作流里的 Xray 提供，连你的 vmess 节点）
import { fetch as ufetch, ProxyAgent } from 'undici';
import crypto from 'node:crypto';

const BASE = 'https://api.botkeep.cloud';
const SITE = 'https://botkeep.cloud';
const env = process.env;

// ---------- 多账号：BOTKEEP_EMAIL / BOTKEEP_PASSWORD 用英文逗号分隔，一一对应 ----------
// 例：BOTKEEP_EMAIL="a@x.com,b@x.com"  BOTKEEP_PASSWORD="pass1,pass2"
function parseAccounts() {
  const emails = (env.BOTKEEP_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  const passwords = (env.BOTKEEP_PASSWORD || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!emails.length) throw new Error('缺少 BOTKEEP_EMAIL');
  if (emails.length !== passwords.length) {
    throw new Error(`账号密码数量不一致：邮箱 ${emails.length} 个，密码 ${passwords.length} 个`);
  }
  return emails.map((email, i) => ({ email, password: passwords[i], idx: i + 1 }));
}

const TG_TOKEN = env.TG_BOT_TOKEN;
const TG_CHAT = env.TG_CHAT_ID;
const NAME = env.SERVER_NAME || 'my-project';
const WANT_RUNTIME = env.RUNTIME || 'python';
const RES = {
  memoryLimitMb: Number(env.RAM_MB || 512),
  cpuLimitPercent: Number(env.CPU_PERCENT || 50),
  storageLimitMb: Number(env.STORAGE_MB || 1024),
};
const RUN_SECONDS = Number(env.RUN_SECONDS || 240);
const INTERVAL_SECONDS = Number(env.INTERVAL_SECONDS || 20);
const PROXY_URL = env.PROXY_URL || '';
const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

// ---------- 黑名单 / 白名单：NODE_BLACKLIST / NODE_WHITELIST，用英文逗号分隔，子串匹配（不区分大小写） ----------
// 黑名单例：NODE_BLACKLIST="node2-it,node5-fr"  → 落点包含这些的机器会被删除
// 白名单例：NODE_WHITELIST="node2-it,node10"    → 落点不在白名单的机器会被删除（只想要特定国家时用这个）
// 两者同时设置时白名单优先；都不设置则不启用
// BLACKLIST_PAUSE_SECONDS：删除后暂停多少秒再继续抢（默认 600 = 10 分钟）
const NODE_BLACKLIST = (env.NODE_BLACKLIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const NODE_WHITELIST = (env.NODE_WHITELIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const BLACKLIST_PAUSE_SECONDS = Number(env.BLACKLIST_PAUSE_SECONDS || 600);

// 每个账号独立的登录态（多账号串行跑，跑下一个账号前重置）
let jar = new Map();
let csrf = null;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function saveCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function api(path, { method = 'GET', body, headers = {}, anonymous = false } = {}) {
  const h = {
    Accept: 'application/json',
    Origin: SITE,
    Referer: `${SITE}/app/create`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36',
    ...headers,
  };
  if (jar.size) h.Cookie = cookieHeader();
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (method !== 'GET' && !anonymous) {
    if (!csrf) csrf = (await api('/api/v1/auth/session')).csrf_token;
    h['X-CSRF-Token'] = csrf;
  }
  const res = await ufetch(BASE + path, {
    method, headers: h, dispatcher,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  saveCookies(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message || data.error)) || text || res.statusText;
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const err = new Error(`${method} ${path} -> ${res.status}: ${s.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data && data.data !== undefined && Object.keys(data).length <= 2 ? data.data : data;
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return log('TG 未配置，跳过通知:', text);
  try {
    await ufetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e) { log('TG 发送失败', e.message); }
}

// 从创建返回里抠节点标识（字段名是推测的，命中多个候选；实际字段以日志打印为准）
function extractNode(bot) {
  const b = bot?.bot || bot || {};
  const nested = b.server || b.instance || {};
  const candidates = [
    b.node, b.hostname, b.host, b.nodeName, b.datacenter, b.region, b.location,
    nested.node, nested.hostname, nested.host, nested.datacenter, nested.region,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function hitList(node, list) {
  const n = node.toLowerCase();
  return list.find((b) => n.includes(b)) || '';
}

// 删除机器（接口为按 REST 惯例推测：DELETE /api/v1/panel/bots/{id}）
async function deleteBot(id) {
  const res = await api(`/api/v1/panel/bots/${id}`, { method: 'DELETE' });
  return res;
}

async function runAccount({ email, password, idx }, total) {
  jar = new Map();
  csrf = null;
  const tag = total > 1 ? `[账号${idx}/${total} ${email}] ` : '';
  log(`${tag}开始`);

  await api('/api/v1/auth/login', { method: 'POST', anonymous: true, body: { email, password } });
  csrf = (await api('/api/v1/auth/session')).csrf_token;
  log(`${tag}登录成功`);

  // 已经有服务器就不再创建（只记日志，不发 TG，免得每次触发都刷屏）
  const dash = await api('/api/v1/panel/dashboard');
  if (Array.isArray(dash?.bots) && dash.bots.length > 0) {
    log(`${tag}已有服务器：` + dash.bots.map((b) => b.name || b.id).join(', ') + '，跳过');
    return;
  }

  // 找运行时（名字可能叫 python / python3 之类，自动匹配）
  const caps = await api('/api/v1/panel/capabilities');
  const all = caps?.runtimes || {};
  log(`${tag}平台支持的运行时：`, Object.keys(all).join(', ') || '(空)');
  let RUNTIME = WANT_RUNTIME;
  if (!all[RUNTIME]) {
    const hit = Object.keys(all).find((k) => k.toLowerCase().includes(WANT_RUNTIME.toLowerCase()));
    if (hit) RUNTIME = hit;
  }
  const versions = all[RUNTIME] || [];
  const runtimeVersion = env.RUNTIME_VERSION || versions[0] || '';
  const startCommand = env.START_COMMAND
    || caps?.runtimeOptions?.[RUNTIME]?.[runtimeVersion]?.command
    || (RUNTIME.startsWith('python') ? 'python main.py' : 'npm start');
  log(`${tag}运行时`, RUNTIME, runtimeVersion || '(未开放)', '启动命令', startCommand);

  const qs = new URLSearchParams({
    runtime: RUNTIME,
    runtimeVersion,
    memoryLimitMb: String(RES.memoryLimitMb),
    cpuLimitPercent: String(RES.cpuLimitPercent),
    storageLimitMb: String(RES.storageLimitMb),
  }).toString();
  let deadline = Date.now() + RUN_SECONDS * 1000;
  let n = 0;

  while (Date.now() < deadline) {
    n++;
    try {
      const avail = await api('/api/v1/panel/creation-availability?' + qs);
      if (avail?.allowed) {
        log(`${tag}第${n}次：有容量，立即创建`);
        const bot = await api('/api/v1/panel/bots', {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: {
            name: NAME, platform: 'general', runtime: RUNTIME, runtimeVersion,
            sourceType: 'blank', repository: '', archiveName: '', branch: 'main',
            startCommand, tokenProvided: false, resources: RES, seedFiles: [],
          },
        });
        const id = bot?.id || bot?.bot?.id || '';
        const node = extractNode(bot);
        log(`${tag}创建成功 id=${id} node=${node || '(未识别)'}`);
        log(`${tag}创建返回原文：`, JSON.stringify(bot).slice(0, 800));

        // ---- 黑名单 / 白名单检查 ----
        // 白名单模式：只保留白名单里的节点，其余删除；黑名单模式：删除黑名单里的节点
        let deleteReason = '';
        if (NODE_WHITELIST.length) {
          if (!node || !hitList(node, NODE_WHITELIST)) {
            deleteReason = `不在白名单内（${NODE_WHITELIST.join(',')}）`;
          }
        } else {
          const hit = node ? hitList(node, NODE_BLACKLIST) : '';
          if (hit) deleteReason = `黑名单 ${hit}`;
        }
        if (deleteReason) {
          const pauseMin = Math.round(BLACKLIST_PAUSE_SECONDS / 60);
          log(`${tag}命中删除规则(${deleteReason})，删除机器 ${id}`);
          try {
            await deleteBot(id);
            log(`${tag}已删除`);
          } catch (e) {
            log(`${tag}删除失败：${e.message}，请手动去面板删除`);
            await tg(`⚠️ Botkeep：${tag}抢到的机器在 ${node || id}（${deleteReason}），但自动删除失败，请手动删除！`);
          }
          await tg(`🗑️ Botkeep：${tag}抢到的机器在 ${node || id}（${deleteReason}），已删除，暂停 ${pauseMin} 分钟后继续抢。`);
          // 暂停不计入轮询时长
          deadline += BLACKLIST_PAUSE_SECONDS * 1000;
          await sleep(BLACKLIST_PAUSE_SECONDS);
          continue;
        }

        await tg(
          `🎉 Botkeep 抢到了！\n${tag}服务器：${NAME}\n${id}\n` +
          (node ? `节点：${node}\n` : '') +
          `${RUNTIME} ${runtimeVersion} / ${RES.memoryLimitMb}MB / ${RES.cpuLimitPercent}% / ${RES.storageLimitMb}MB\n` +
          `${SITE}/app\n之后暂停 24 小时，到时只检查机器是否还在。`
        );
        return;
      }
      log(`${tag}第${n}次：无容量 - ${avail?.message || ''}`);
    } catch (e) {
      log(`${tag}第${n}次出错：${e.message}`);
      if (e.status === 401 || e.status === 403) { csrf = null; }
      if (e.status === 429) await sleep(INTERVAL_SECONDS * 2);
    }
    await sleep(INTERVAL_SECONDS);
  }
  log(`${tag}本次未抢到，等下次触发`);
}

async function main() {
  const accounts = parseAccounts();
  const mode = NODE_WHITELIST.length
    ? `白名单模式：${NODE_WHITELIST.join(',')}`
    : NODE_BLACKLIST.length ? `黑名单模式：${NODE_BLACKLIST.join(',')}` : '未设名单';
  log(`共 ${accounts.length} 个账号，${mode}`);
  log(PROXY_URL ? `使用代理 ${PROXY_URL}` : '未使用代理，直连');
  for (const acc of accounts) {
    try {
      await runAccount(acc, accounts.length);
    } catch (e) {
      log(`[账号${acc.idx} ${acc.email}] 失败：${e.message}`);
      await tg(`⚠️ Botkeep 抢机器 [账号${acc.idx} ${acc.email}] 出错：${e.message}`);
    }
  }
}

main().catch(async (e) => {
  log('致命错误', e.message, e.cause ? `(${e.cause.message || e.cause})` : '');
  await tg(`⚠️ Botkeep 抢机器脚本出错：${e.message}`);
  process.exit(1);
});
