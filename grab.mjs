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

// ---------- 黑名单 / 白名单：NODE_BLACKLIST / NODE_WHITELIST，用英文逗号分隔 ----------
// 黑名单例：NODE_BLACKLIST="node2-it,node10"  → 落点是这两个节点的机器会被删除
// 白名单例：NODE_WHITELIST="node2-it,node10,node4" → 只保留这三个节点的机器，其余删除
// 两者同时设置时白名单优先；都不设置则不启用
// 匹配规则：条目中的 nodeN 按编号精确匹配（"node1" 不会误伤 node10/node11；"node2-it"→编号2），
//   且兼容面板可能返回的 "eu-NN" 写法（eu-04→编号4，见 botkeep 官网 "node eu-04" 的日志格式）。
//   条目里没有编号的（如写国家名）才走子串兜底匹配（不区分大小写）。
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

// 节点识别（实测结论 2026-10-17，直连面板 API 验证）：
// Botkeep 里节点就是 bot 对象上的数字字段 placementNodeId，
// 创建返回 / GET /api/v1/panel/bots/{id} / dashboard 的 bot 对象里都有，
// 实测 placementNodeId=8 的机器面板上显示为 node8。
// 映射规则：placementNodeId N（1~11）即 nodeN；超出 1~11 的一律不认，走保守路径。
// 找不到编号时返回空，走保守路径（保留+人工确认），绝不误删。
function extractNodeInfo(...objs) {
  const nums = new Set();
  const hits = [];
  const walk = (v, depth) => {
    if (v == null || depth > 4) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (/^placementnodeid$/i.test(k) && typeof val === 'number' && Number.isInteger(val)) {
        if (val >= 1 && val <= 11) {
          nums.add(String(val));
          hits.push(`placementNodeId=${val}→node${val}`);
        } else {
          hits.push(`placementNodeId=${val}(未知节点)`);
        }
      } else if (typeof val === 'string' && val) {
        // 兜底：字符串里出现 nodeN / eu-NN 也抓出来（如 node8.botkeep.cloud）
        const t = val.toLowerCase();
        for (const m of t.matchAll(/\bnode\s*0*(\d{1,2})\b/g)) { nums.add(String(Number(m[1]))); hits.push(m[0]); }
        for (const m of t.matchAll(/\beu[-\s]?0*(\d{1,2})\b/g)) { nums.add(String(Number(m[1]))); hits.push(m[0]); }
      }
      walk(val, depth + 1);
    }
  };
  objs.forEach((o) => walk(o, 0));
  return { raw: [...new Set(hits)].slice(0, 5).join(','), nums: [...nums] };
}

// 创建后节点可能是异步分配的：查详情（重试3次）→ 兜底查 dashboard，按 id 或 name 找
async function fetchBotDetails(id, tag) {
  for (let i = 0; i < 3; i++) {
    try {
      const d = await api(`/api/v1/panel/bots/${id}`);
      const probe = extractNodeInfo(d);
      if (probe.nums.length || probe.raw) return d;
      log(`${tag}详情第${i + 1}次：还没拿到节点信息`);
    } catch (e) { log(`${tag}取机器详情失败(${i + 1}/3)：${e.message}`); }
    await sleep(5);
  }
  try {
    const dash = await api('/api/v1/panel/dashboard');
    const bots = Array.isArray(dash?.bots) ? dash.bots : [];
    const hit = bots.find((b) => (b.id || b.bot?.id) === id || (b.name || b.bot?.name) === NAME);
    if (hit) { log(`${tag}从 dashboard 找到机器`); return hit; }
  } catch (e) { log(`${tag}取 dashboard 失败：${e.message}`); }
  return null;
}

// 名单条目里的编号： "node2-it"→"2"， "node10"→"10"，无编号返回 ''
function entryNum(entry) {
  const m = entry.toLowerCase().match(/node\s*0*(\d+)/);
  return m ? String(Number(m[1])) : '';
}

// 名单匹配：有编号的条目按编号精确匹配；无编号的条目走子串兜底。返回命中的条目或 ''
function matchList(nodeInfo, list) {
  if (!list.length) return '';
  const { raw, nums } = nodeInfo;
  for (const entry of list) {
    const n = entryNum(entry);
    if (n) {
      if (nums.includes(n)) return entry;
      continue;
    }
    if (raw.includes(entry)) return entry;
  }
  return '';
}

// 删除机器：DELETE /api/v1/panel/bots/{id}（2026-10-17 面板删除流程验证有效）。
// 注意：服务端要求 JSON 请求，DELETE 必须带 Content-Type: application/json（body 传 {}），
// 否则返回 415 "JSON requests are required."。
async function deleteBot(id) {
  const res = await api(`/api/v1/panel/bots/${id}`, { method: 'DELETE', body: {} });
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
        let nodeInfo = extractNodeInfo(bot);
        // 创建返回里可能还没有节点信息（异步分配）→ 查详情重试
        if (!nodeInfo.nums.length) {
          log(`${tag}创建返回里没拿到节点编号，取详情重试…`);
          const details = await fetchBotDetails(id, tag);
          if (details) {
            nodeInfo = extractNodeInfo(bot, details);
            log(`${tag}详情取回 node=${nodeInfo.raw ? nodeInfo.raw.slice(0, 120) : '(仍未识别)'} 解析编号=[${nodeInfo.nums.join(',') || '-'}]`);
          }
        }
        const nodeLabel = nodeInfo.raw ? nodeInfo.raw.slice(0, 160) : '(未识别)';
        log(`${tag}创建成功 id=${id} node=${nodeLabel} 解析编号=[${nodeInfo.nums.join(',') || '-'}]`);
        log(`${tag}创建返回原文：`, JSON.stringify(bot).slice(0, 800));

        // ---- 黑名单 / 白名单检查 ----
        // 白名单模式：落点在白名单 → 保留；落点确认为其他已知节点 → 删除+暂停+继续抢；
        //   落点无法解析为已知节点编号 → 保守保留 + TG 提醒人工确认（绝不误删想要的机器）。
        // 黑名单模式：落点命中黑名单 → 删除；否则保留。
        let deleteReason = '';
        let nodeAmbiguous = false;
        if (NODE_WHITELIST.length) {
          if (!nodeInfo.raw) {
            nodeAmbiguous = true; // 完全没拿到节点信息
          } else if (!matchList(nodeInfo, NODE_WHITELIST)) {
            if (nodeInfo.nums.length) {
              deleteReason = `不在白名单内（${NODE_WHITELIST.join(',')}）`;
            } else {
              nodeAmbiguous = true; // 有字符串但解析不出节点编号，不敢删
            }
          }
        } else if (NODE_BLACKLIST.length && nodeInfo.raw) {
          const hit = matchList(nodeInfo, NODE_BLACKLIST);
          if (hit) deleteReason = `命中黑名单 ${hit}`;
        }
        if (nodeAmbiguous) {
          log(`${tag}落点节点无法确认为已知节点格式（${nodeLabel}），保留机器 ${id}，提醒人工确认`);
          await tg(`⚠️ Botkeep：${tag}抢到了（${id}），落点显示为「${nodeLabel}」，无法确认是否符合白名单，已保留，请去面板手动确认，符合预期就留着，不符合就手动删除。`);
          return;
        }
        if (deleteReason) {
          const pauseMin = Math.round(BLACKLIST_PAUSE_SECONDS / 60);
          log(`${tag}命中删除规则(${deleteReason})，删除机器 ${id}（落点 ${nodeLabel}）`);
          try {
            await deleteBot(id);
          } catch (e) {
            // 删除失败：名额已被占用，继续轮询没有意义，提醒人工处理后结束本账号
            log(`${tag}删除失败：${e.message}，请手动去面板删除`);
            await tg(`⚠️ Botkeep：${tag}抢到的机器（落点 ${nodeLabel}）（${deleteReason}），但自动删除失败，请手动去面板删除！`);
            return;
          }
          log(`${tag}已删除`);
          await tg(`🗑️ Botkeep：${tag}抢到的机器（落点 ${nodeLabel}）（${deleteReason}），已删除，暂停 ${pauseMin} 分钟后继续抢。`);
          // 暂停不计入轮询时长
          deadline += BLACKLIST_PAUSE_SECONDS * 1000;
          await sleep(BLACKLIST_PAUSE_SECONDS);
          continue;
        }

        await tg(
          `🎉 Botkeep 抢到了！\n${tag}服务器：${NAME}\n${id}\n` +
          (nodeInfo.raw ? `落点：${nodeLabel}\n` : '') +
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
