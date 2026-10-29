// service.mjs — claude-code-web-service 主入口（v0.1.0）
// 把 Claude Code 能力开放为 HTTP + SSE API，接口形状对齐 zcode-web-service / dsh-web-service。
// 零依赖 Node（>=18）。运行：node service.mjs [--config <path>] [--port N] [--data-dir <dir>]
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ClaudeEngine } from './engine.mjs'
import { HttpRouter, sendJson } from './http.mjs'
import { ApiKeyStore } from './keys-store.mjs'
import { registerSystemRoutes } from './routes/system.mjs'
import { registerWorkspaceRoutes } from './routes/workspaces.mjs'
import { registerSessionRoutes } from './routes/sessions.mjs'
import { registerStreamingRoutes } from './routes/streaming.mjs'
import { registerModelRoutes } from './routes/models.mjs'
import { registerFsRoutes } from './routes/fs.mjs'
import { registerFileRoutes } from './routes/files.mjs'
import { registerSkillRoutes } from './routes/skills.mjs'
import { registerPluginRoutes } from './routes/plugins.mjs'
import { registerQuestionRoutes } from './routes/questions.mjs'
import { registerApiKeyRoutes } from './routes/keys.mjs'
import { collectEvents } from './replay.mjs'

const SERVICE_VERSION = '0.1.0'
const execFileAsync = promisify(execFile)

// ---------- config ----------

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--data-dir') out.dataDir = argv[++i]
  }
  return out
}

const cliArgs = parseArgs(process.argv)
const dataDir = cliArgs.dataDir || process.env.CCWS_DATA_DIR || path.join(os.homedir(), '.claude', 'claude-code-web-service')
const configPath = cliArgs.config || process.env.CCWS_CONFIG || path.join(dataDir, 'config.json')

const DEFAULT_CONFIG = {
  pathPrefix: '/api/v1',
  port: 3082,
  bind: '127.0.0.1',
  allowRemote: false,
  cors: true,
  claudeBin: 'claude',
  defaultMode: 'default',
  defaultModel: '',
  defaultWorkspace: '',
  apiKeys: [],
  customSkillDirs: [],
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  adminRemoteAccess: false,
  /** 一轮对话「无事件停滞」上限；持续有事件不会被打断 */
  turnStallTimeoutMs: 180_000,
  /** 空闲会话进程回收（0=不回收；回收后下次 prompt 自动 --resume 复活） */
  sessionIdleTimeoutMs: 30 * 60_000,
  /** 并发会话进程上限 */
  maxSessions: 32,
  /** token 级流式（--include-partial-messages） */
  streamPartial: true,
}

async function loadConfig() {
  let fileCfg = {}
  if (existsSync(configPath)) {
    try { fileCfg = JSON.parse(await readFile(configPath, 'utf8')) }
    catch (e) { console.error(`[config] failed to parse ${configPath}: ${e.message}`) }
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg }
  if (!Array.isArray(cfg.apiKeys)) cfg.apiKeys = []
  return cfg
}

// ---------- logging ----------

let logStream = null
async function initLog() {
  await mkdir(path.join(dataDir, 'logs'), { recursive: true })
  const { createWriteStream } = await import('node:fs')
  logStream = createWriteStream(path.join(dataDir, 'logs', 'service.log'), { flags: 'a' })
}
function log(level, msg, extra) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra).slice(0, 500) : ''}`
  console.error(line)
  logStream?.write(line + '\n')
}

// ---------- main ----------

async function main() {
  await mkdir(dataDir, { recursive: true })
  await initLog()
  const cfg = await loadConfig()
  if (cliArgs.port) cfg.port = cliArgs.port
  const prefix = cfg.pathPrefix || '/api/v1'

  const engine = new ClaudeEngine({
    claudeBin: cfg.claudeBin,
    cwd: dataDir,
    dataDir,
    defaultMode: cfg.defaultMode,
    defaultModel: cfg.defaultModel,
    streamPartial: cfg.streamPartial,
    sessionIdleTimeoutMs: cfg.sessionIdleTimeoutMs,
    maxSessions: cfg.maxSessions,
    turnStallTimeoutMs: cfg.turnStallTimeoutMs,
    log: (level, msg, extra) => log(level, msg, extra),
  })

  const keyStore = new ApiKeyStore(dataDir, cfg.apiKeys)
  keyStore.ensureReady()
  keyStore.ensureAdminToken()

  const startedAt = Date.now()
  const sseClients = new Set()
  const ctx = { dataDir, startedAt, version: SERVICE_VERSION, prefix, engine, sseClients, cliVersion: null, collectEvents }

  ;(async () => {
    try {
      const r = await execFileAsync(cfg.claudeBin, ['--version'], { timeout: 15000 })
      ctx.cliVersion = r.stdout.trim().match(/\d+\.\d+\.\d+[^\s)]*/)?.[0] || r.stdout.trim().split(/\s+/)[0]
    } catch { /* non-fatal */ }
  })()

  engine.on('session-event', ev => {
    for (const c of sseClients) {
      if (c.sessionId === ev.sessionId || c.sessionId === '*') c.send('session.event', ev)
    }
  })
  engine.on('interaction', entry => {
    log('info', `pending interaction ${entry.kind} session=${entry.sessionId} tool=${entry.toolName} id=${entry.msgId}`)
  })

  // ---------- router ----------

  cfg.dataDir = dataDir // 供缺省工作目录兜底（routes 内不可达模块级 dataDir 时经 cfg 取）
  const router = new HttpRouter(cfg)
  router.setAuthService(keyStore)
  router.setRemoteGate(req => {
    if (cfg.allowRemote) return false
    const addr = req.socket?.remoteAddress || ''
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
    return !loopback
  })

  registerSystemRoutes(router, cfg, ctx, keyStore)
  registerWorkspaceRoutes(router, engine, cfg, ctx)
  registerSessionRoutes(router, engine, cfg, ctx)
  registerStreamingRoutes(router, engine, cfg, ctx)
  registerModelRoutes(router, engine, cfg, ctx)
  registerFsRoutes(router, cfg)
  registerFileRoutes(router, engine, cfg)
  registerSkillRoutes(router, cfg)
  registerPluginRoutes(router, cfg)
  registerQuestionRoutes(router, engine)
  registerApiKeyRoutes(router, { ...cfg, serviceVersion: SERVICE_VERSION }, keyStore)

  const server = createServer(async (req, res) => {
    try {
      const handled = await router.dispatch(req, res, prefix)
      if (!handled && !res.headersSent) {
        sendJson(res, 404, { ok: false, error: `Endpoint not found: ${req.url}`, code: 'NOT_FOUND' })
      }
    } catch (e) {
      log('error', `dispatch error: ${e.stack || e.message}`, { url: req.url })
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message, code: 'INTERNAL_ERROR' })
      else res.end()
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.bind, resolve)
  })
  log('info', `claude-code-web-service ${SERVICE_VERSION} listening on http://${cfg.bind}:${cfg.port}${prefix}`)
  log('info', `data dir: ${dataDir} | config: ${configPath} | allowRemote=${cfg.allowRemote} | defaultMode=${cfg.defaultMode} | auth=${keyStore.isEnforced()}`)

  const shutdown = sig => {
    log('info', `received ${sig}, shutting down`)
    engine.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch(e => {
  console.error(`fatal: ${e.stack || e.message}`)
  process.exit(1)
})
