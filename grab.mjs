// Botkeep 免费机器抢购脚本 (Node.js 20+) —— Python 版 + 代理
// 流程：登录 -> 轮询容量 -> 有容量立即创建 Python 服务器 -> 成功TG通知
// 访问 Botkeep 的请求会走 PROXY_URL（由工作流里的 Xray 提供，连你的 vmess 节点）
import { fetch as ufetch, ProxyAgent } from 'undici';

const BASE = 'https://api.botkeep.cloud';
const SITE = 'https://botkeep.cloud';
const env = process.env;
const EMAIL = env.BOTKEEP_EMAIL;
const PASSWORD = env.BOTKEEP_PASSWORD;
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

const jar = new Map();
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

let csrf = null;
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

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error('缺少 BOTKEEP_EMAIL / BOTKEEP_PASSWORD');
  log(PROXY_URL ? `使用代理 ${PROXY_URL}` : '未使用代理，直连');

  await api('/api/v1/auth/login', { method: 'POST', anonymous: true, body: { email: EMAIL, password: PASSWORD } });
  csrf = (await api('/api/v1/auth/session')).csrf_token;
  log('登录成功');

  // 已经有服务器就不再创建（只记日志，不发 TG，免得每次触发都刷屏）
  const dash = await api('/api/v1/panel/dashboard');
  if (Array.isArray(dash?.bots) && dash.bots.length > 0) {
    log('账号已有服务器：' + dash.bots.map((b) => b.name || b.id).join(', ') + '，无需再抢，可以关掉定时触发了');
    return;
  }

  // 找 Python 运行时（名字可能叫 python / python3 之类，自动匹配）
  const caps = await api('/api/v1/panel/capabilities');
  const all = caps?.runtimes || {};
  log('平台支持的运行时：', Object.keys(all).join(', ') || '(空)');
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
  log('运行时', RUNTIME, runtimeVersion || '(未开放)', '可选版本', versions.join('/') || '-', '启动命令', startCommand);

  const qs = new URLSearchParams({
    runtime: RUNTIME,
    runtimeVersion,
    memoryLimitMb: String(RES.memoryLimitMb),
    cpuLimitPercent: String(RES.cpuLimitPercent),
    storageLimitMb: String(RES.storageLimitMb),
  }).toString();
  const idemKey = crypto.randomUUID();
  const deadline = Date.now() + RUN_SECONDS * 1000;
  let n = 0;

  while (Date.now() < deadline) {
    n++;
    try {
      const avail = await api('/api/v1/panel/creation-availability?' + qs);
      if (avail?.allowed) {
        log(`第${n}次：有容量，立即创建`);
        const bot = await api('/api/v1/panel/bots', {
          method: 'POST',
          headers: { 'Idempotency-Key': idemKey },
          body: {
            name: NAME, platform: 'general', runtime: RUNTIME, runtimeVersion,
            sourceType: 'blank', repository: '', archiveName: '', branch: 'main',
            startCommand, tokenProvided: false, resources: RES, seedFiles: [],
          },
        });
        const id = bot?.id || bot?.bot?.id || '';
        log('创建成功', JSON.stringify(bot).slice(0, 300));
        await tg(`🎉 Botkeep 抢到了！\n服务器：${NAME} ${id}\n${RUNTIME} ${runtimeVersion} / ${RES.memoryLimitMb}MB / ${RES.cpuLimitPercent}% / ${RES.storageLimitMb}MB\n${SITE}/app\n\n记得去 Cloudflare 删掉触发 Worker 的 Cron`);
        return;
      }
      log(`第${n}次：无容量 - ${avail?.message || ''}`);
    } catch (e) {
      log(`第${n}次出错：${e.message}`);
      if (e.status === 401 || e.status === 403) { csrf = null; }
      if (e.status === 429) await sleep(INTERVAL_SECONDS * 2);
    }
    await sleep(INTERVAL_SECONDS);
  }
  log('本次未抢到，等下次触发');
}

main().catch(async (e) => {
  log('致命错误', e.message, e.cause ? `(${e.cause.message || e.cause})` : '');
  await tg(`⚠️ Botkeep 抢机器脚本出错：${e.message}`);
  process.exit(1);
});
