// 把 vmess:// 链接转换成 Xray 客户端配置
// 本地开一个 HTTP 代理 127.0.0.1:10809，所有流量走你的 vmess 节点
// 用法：VMESS_LINK='vmess://...' node make-xray-config.mjs > config.json
const link = (process.env.VMESS_LINK || '').trim();
if (!link.startsWith('vmess://')) {
  console.error('VMESS_LINK 不是 vmess:// 开头，请检查 Secret');
  process.exit(1);
}

let v;
try {
  let b64 = link.slice(8).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  while (b64.length % 4) b64 += '=';
  v = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
} catch {
  console.error('vmess 链接解析失败：只支持 v2rayN 格式（vmess:// 后面是一段 base64）');
  process.exit(1);
}

const net = (v.net || 'tcp').toLowerCase();
const security = String(v.tls || '').toLowerCase() === 'tls' ? 'tls' : 'none';
const host = v.host || '';
const path = v.path || '/';
const sni = v.sni || host || v.add;

const stream = { network: net, security };

if (security === 'tls') {
  stream.tlsSettings = {
    serverName: sni,
    allowInsecure: String(v.allowInsecure || v.insecure || '') === '1' || v.allowInsecure === true,
    fingerprint: v.fp || 'chrome',
  };
  if (v.alpn) stream.tlsSettings.alpn = String(v.alpn).split(',').map((s) => s.trim()).filter(Boolean);
}

if (net === 'ws') {
  stream.wsSettings = { path, headers: host ? { Host: host } : {} };
} else if (net === 'grpc') {
  stream.grpcSettings = { serviceName: v.path || v.serviceName || '', multiMode: v.type === 'multi' };
} else if (net === 'httpupgrade') {
  stream.httpupgradeSettings = { path, host };
} else if (net === 'xhttp' || net === 'splithttp') {
  stream.network = 'xhttp';
  stream.xhttpSettings = { path, host, mode: v.type && v.type !== 'none' ? v.type : 'auto' };
} else if (net === 'tcp' && v.type === 'http') {
  stream.tcpSettings = {
    header: {
      type: 'http',
      request: { path: path.split(','), headers: host ? { Host: host.split(',') } : {} },
    },
  };
} else if (net !== 'tcp') {
  console.error(`暂不支持的传输方式：${net}（支持 tcp / ws / grpc / httpupgrade / xhttp）`);
  process.exit(1);
}

const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    { tag: 'http-in', listen: '127.0.0.1', port: 10809, protocol: 'http' },
  ],
  outbounds: [
    {
      tag: 'vmess-out',
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: v.add,
          port: Number(v.port),
          users: [{ id: v.id, alterId: Number(v.aid || 0), security: v.scy || 'auto' }],
        }],
      },
      streamSettings: stream,
    },
  ],
};

console.log(JSON.stringify(config, null, 2));
console.error(`节点：${v.ps || '(无名称)'} | 传输：${stream.network} | TLS：${security}`);
