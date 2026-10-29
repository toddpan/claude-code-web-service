// routes/system.mjs — 系统状态 / 更新检查 / 机器指纹 / OpenAPI / Swagger UI 文档页
// （路由与形状对齐 zcode-web-service system.mjs）
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson } from '../http.mjs'
import { collectMachineIdentity, collectLanIpv4 } from '../netinfo.mjs'
import { buildOpenApiSpec } from './openapi-spec.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vendorDir = path.resolve(__dirname, '..', '..', 'vendor', 'swagger-ui')

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
}

export function registerSystemRoutes(router, cfg, ctx, keyStore) {
  const startedAt = ctx.startedAt
  const serviceVersion = ctx.version
  // 服务地址列表：回环恒可达；bind 0.0.0.0 时补充局域网地址（对齐 dsh ServiceState.urls）
  const serviceUrls = (() => {
    const urls = [`http://127.0.0.1:${cfg.port}${ctx.prefix}`]
    if (cfg.bind === '0.0.0.0') {
      for (const ip of collectLanIpv4()) {
        const url = `http://${ip}:${cfg.port}${ctx.prefix}`
        if (!urls.includes(url)) urls.push(url)
      }
    }
    return urls
  })()

  // 系统状态（data 鉴权，对齐 dsh）
  router.get('/system/status', async (_req, res) => {
    keyStore.ensureReady()
    sendJson(res, 200, {
      ok: true,
      data: {
        name: 'claude-code-web-service',
        version: serviceVersion,
        status: 'running',
        port: cfg.port,
        // 独立 API 服务字段（对齐 dsh）：本服务即常驻独立服务（launchd 托管）
        standalonePort: cfg.port,
        standaloneRunning: true,
        standaloneBindIp: cfg.bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
        serviceUrls,
        prefix: ctx.prefix,
        workspacesCount: undefined,
        providers: undefined,
        claudeVersion: ctx.cliVersion,
        engineVersion: ctx.cliVersion,
        engineRunning: true,
        enginePid: process.pid,
        sessionsLive: ctx.engine.sessions.size,
        lastExit: null,
        pendingQuestions: ctx.engine.interactions.size,
        authEnabled: keyStore.getAuthEnabled(),
        apiKeyCount: keyStore.countActive(),
        keysStoreDegraded: keyStore.degraded,
        uptime: process.uptime(),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        sseClients: ctx.sseClients?.size ?? 0,
      },
    })
  })

  // 更新检查（公开）：GitHub Releases 为发布渠道
  router.get('/system/updates', async (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      data: {
        current: serviceVersion,
        latest: null,
        updateAvailable: false,
        checkedAt: Date.now(),
        note: '更新请重跑在线安装脚本或 scripts/install.sh',
      },
    })
  }, { auth: 'public' })

  // 机器指纹 ping
  router.get('/ping', async (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      data: {
        ...collectMachineIdentity(),
        hint: '比较 data.macs（首选，主机级稳定标识）或 data.ips 与调用方自身网卡即可判定该节点是否本机；127.0.0.1 节点 MAC 命中本机则为本地节点，否则是隧道转发的远端节点',
      },
    })
  })

  // liveness（免鉴权，launchd/监控用；dsh 无此路由，附加能力）
  router.get('/healthz', async (_req, res) => {
    sendJson(res, 200, { ok: true })
  }, { auth: 'public' })

  // ---------- OpenAPI / 文档 ----------

  router.get('/openapi.json', (_req, res) => {
    sendJson(res, 200, buildOpenApiSpec(cfg, serviceVersion))
  }, { auth: 'public' })

  // /docs → 服务入口页：主行动直达 API Key 管理，次级入口 Swagger / OpenAPI
  router.get('/docs', (_req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-code-web-service</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;background:#f6f7f9;color:#1f2329}
main{max-width:640px;width:100%}
h1{font-size:24px;margin:0 0 4px}
.sub{color:#6b7280;font-size:13.5px;margin-bottom:28px}
.hero{display:block;background:linear-gradient(135deg,#1e293b,#0f172a);color:#fff;border-radius:16px;padding:28px 26px;text-decoration:none;box-shadow:0 10px 30px rgba(15,23,42,.18);transition:transform .15s ease,box-shadow .15s ease}
.hero:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(15,23,42,.26)}
.hero .t{font-size:19px;font-weight:600;display:flex;align-items:center;gap:8px}
.hero .d{color:#cbd5e1;font-size:13.5px;margin:8px 0 18px}
.hero .go{display:inline-flex;align-items:center;gap:6px;background:#fff;color:#0f172a;font-weight:600;font-size:14px;border-radius:10px;padding:9px 16px}
.row{display:flex;gap:12px;margin-top:14px;flex-wrap:wrap}
.minor{flex:1 1 180px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;text-decoration:none;color:#1f2329;transition:border-color .15s ease}
.minor:hover{border-color:#94a3b8}
.minor .mt{font-weight:600;font-size:14px;color:#2563eb}
.minor .md{font-size:12.5px;color:#6b7280;margin-top:4px}
.hint{margin-top:26px;font-size:12.5px;color:#9ca3af}
code{background:rgba(0,0,0,.06);padding:1px 6px;border-radius:6px;font-size:12px}
@media(prefers-color-scheme:dark){body{background:#0b0f17;color:#e5e7eb}.sub,.minor .md,.hint{color:#8b95a5}.minor{background:#131a24;border-color:#263041}.minor:hover{border-color:#3d4a5f}.minor .mt{color:#7ab0ff}code{background:rgba(255,255,255,.08)}}
</style></head>
<body><main>
<h1>claude-code-web-service <span style="font-size:14px;color:#6b7280;font-weight:400">v${serviceVersion}</span></h1>
<div class="sub">Claude Code 的 HTTP + SSE 封装，默认监听 <code>127.0.0.1:${cfg.port}</code></div>

<a class="hero" href="settings/api-keys">
  <div class="t">🔑 API Key 管理</div>
  <div class="d">新建、复制、轮换、吊销调用密钥；管理数据面鉴权开关</div>
  <span class="go">进入管理 <span aria-hidden="true">→</span></span>
</a>

<div class="row">
  <a class="minor" href="reference"><div class="mt">API 交互文档</div><div class="md">Swagger UI（OpenAPI 3.0，离线自托管）</div></a>
  <a class="minor" href="openapi.json"><div class="mt">OpenAPI JSON</div><div class="md"><code>openapi.json</code> 机器可读规范</div></a>
</div>

<p class="hint">数据面接口鉴权：<code>Authorization: Bearer &lt;apiKey&gt;</code> 或 <code>X-API-Key</code>；远程访问需在配置开启 allowRemote。</p>
</main></body></html>`)
  }, { auth: 'public' })

  // Swagger UI（自托管，离线可用）
  router.get('/docs/reference', (_req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-code-web-service · API Reference</title>
<link rel="stylesheet" href="assets/swagger-ui.css">
<style>.topbar{display:none}body{margin:0}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="assets/swagger-ui-bundle.js"></script>
<script>
window.ui = SwaggerUIBundle({
  url: '../openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  persistAuthorization: true,
})
</script>
</body>
</html>`)
  }, { auth: 'public' })

  router.get('/docs/assets/:file', (_req, res, p) => {
    const name = path.basename(p.file)
    const file = path.join(vendorDir, name)
    if (!existsSync(file)) {
      return sendJson(res, 404, { ok: false, error: 'asset not found', code: 'NOT_FOUND' })
    }
    readFile(file).then(data => {
      res.statusCode = 200
      res.setHeader('Content-Type', MIME[path.extname(name)] || 'application/octet-stream')
      res.setHeader('Content-Length', data.length)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.end(data)
    }).catch(() => sendJson(res, 500, { ok: false, error: 'read failed', code: 'INTERNAL_ERROR' }))
  }, { auth: 'public' })
}
