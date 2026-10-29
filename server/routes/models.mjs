// routes/models.mjs — 模型目录 / 提供方 / 预设 / 设置（对齐 zcode-web-service models.ts 的路由与形状）
import { sendJson } from '../http.mjs'
import { MODES } from '../engine.mjs'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** Claude Code 已知模型别名（CLI --model 接受 alias 或完整 id；目录缓存活会话实测模型） */
const KNOWN_MODELS = [
  { id: 'opus', name: 'Claude Opus', contextLimit: 200000, reasoning: true },
  { id: 'sonnet', name: 'Claude Sonnet', contextLimit: 200000, reasoning: true },
  { id: 'haiku', name: 'Claude Haiku', contextLimit: 200000, reasoning: true },
  { id: 'opusplan', name: 'Claude Opus Plan', contextLimit: 200000, reasoning: false },
]
const EFFORT_LEVELS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

function observedModel(engine, ctx) {
  // 任一活会话 init 事件上报的实测模型（含 [1m] 等 variant 后缀）
  for (const s of engine.sessions.values()) {
    if (s.alive && s.model) return s.model
  }
  return ''
}

function currentModelId(engine, cfg, ctx) {
  return cfg.defaultModel || observedModel(engine, ctx) || 'sonnet'
}

export function registerModelRoutes(router, engine, cfg, ctx) {
  // 1. 模型列表
  router.get('/models', async (_req, res) => {
    try {
      const cur = currentModelId(engine, cfg, ctx)
      const seen = new Set(KNOWN_MODELS.map(m => m.id))
      const models = KNOWN_MODELS.map(m => ({
        id: m.id,
        provider: 'anthropic',
        name: m.name,
        contextLimit: m.contextLimit,
        reasoning: m.reasoning ? { efforts: EFFORT_LEVELS, defaultEffort: 'medium' } : undefined,
        isDefault: cur === m.id || cur.startsWith(m.id),
      }))
      // 活会话上报的非别名模型（如 claude-opus-5[1m]）补进列表
      const obs = observedModel(engine, ctx)
      if (obs && !seen.has(obs)) {
        models.push({
          id: obs, provider: 'anthropic', name: obs, contextLimit: undefined,
          reasoning: { efforts: EFFORT_LEVELS, defaultEffort: 'medium' },
          isDefault: cur === obs,
        })
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          defaultModel: { provider: 'anthropic', model: cur },
          models,
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 2. 全局默认模型（配置级 cfg.defaultModel；未配置时回落实测/别名）
  router.get('/models/default', async (_req, res) => {
    try {
      sendJson(res, 200, { ok: true, data: { provider: 'anthropic', model: currentModelId(engine, cfg, ctx) } })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 3. 修改全局默认模型（写 config.defaultModel，新会话生效；会话级请用 PUT /sessions/:id）
  router.put('/models/default', async (_req, res, _p, _q, body) => {
    if (!body || !body.model) {
      return sendJson(res, 400, { ok: false, error: "Missing required field 'model'（provider 恒为 anthropic，可省略）", code: 'BAD_REQUEST' })
    }
    const model = String(body.model).includes('/') ? String(body.model).split('/').slice(1).join('/') : String(body.model)
    try {
      const configPath = path.join(ctx.dataDir, 'config.json')
      const fileCfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {}
      fileCfg.defaultModel = model
      writeFileSync(configPath, JSON.stringify(fileCfg, null, 2))
      cfg.defaultModel = model
      sendJson(res, 200, { ok: true, data: { provider: 'anthropic', model, applied: true, note: '对新会话生效；存量会话用 PUT /sessions/:id {model}' } })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 4. 提供方列表
  router.get('/providers', async (_req, res) => {
    try {
      sendJson(res, 200, {
        ok: true,
        data: [{ id: 'anthropic', displayName: 'Anthropic', models: KNOWN_MODELS.map(m => m.id) }],
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 5. Agent 预设（无 agentPresets：返回空列表保持形状）
  router.get('/presets', async (_req, res) => {
    sendJson(res, 200, { ok: true, data: { presets: [] } })
  })

  // 6. 服务设置视图（只暴露非敏感字段）
  router.get('/settings', async (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      data: {
        service: {
          port: cfg.port,
          bind: cfg.bind,
          allowRemote: Boolean(cfg.allowRemote),
          defaultMode: cfg.defaultMode,
          defaultWorkspace: cfg.defaultWorkspace,
          corsOrigins: cfg.corsOrigins,
          claudeBin: cfg.claudeBin,
          defaultModel: cfg.defaultModel || '',
          customSkillDirs: cfg.customSkillDirs || [],
        },
      },
    })
  })

  // 7. 更新服务设置（仅 web-service 命名空间的安全子集；port/bind 改后需重启）
  router.patch('/settings/:namespace', async (_req, res, p, _q, body) => {
    if (p.namespace !== 'service' && p.namespace !== 'web-service') {
      return sendJson(res, 404, { ok: false, error: `Unknown settings namespace: ${p.namespace}（本服务仅支持 web-service）`, code: 'NOT_FOUND' })
    }
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'Invalid settings patch body', code: 'BAD_REQUEST' })
    const patchable = ['defaultMode', 'defaultWorkspace', 'corsOrigins', 'customSkillDirs', 'defaultModel']
    const needsRestart = ['port', 'bind', 'allowRemote', 'claudeBin']
    const configPath = path.join(ctx.dataDir, 'config.json')
    try {
      const fileCfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {}
      for (const k of patchable) {
        if (body[k] !== undefined) {
          if (k === 'defaultMode' && !MODES.has(body[k])) return sendJson(res, 400, { ok: false, error: `defaultMode must be one of ${[...MODES].join('/')}`, code: 'BAD_REQUEST' })
          fileCfg[k] = body[k]
          cfg[k] = body[k]
        }
      }
      const touchedRestart = []
      for (const k of needsRestart) {
        if (body[k] !== undefined) {
          fileCfg[k] = body[k]
          touchedRestart.push(k)
        }
      }
      writeFileSync(configPath, JSON.stringify(fileCfg, null, 2))
      sendJson(res, 200, {
        ok: true,
        data: {
          applied: patchable.filter(k => body[k] !== undefined),
          ...(touchedRestart.length ? { requiresRestart: touchedRestart, hint: 'launchctl kickstart -k gui/$UID/com.claude-code.webservice' } : {}),
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })
}
