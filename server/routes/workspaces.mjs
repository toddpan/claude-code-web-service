// routes/workspaces.mjs — 工作区视图（对齐 dsh workspaces.ts 路由与形状）
// ZCode 没有“工作区注册表”服务：工作区从会话列表的 workspacePath 派生；
// 标题覆写与空工作区登记保存在 dataDir/workspace-registry.json。
import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { sendJson } from '../http.mjs'

const REGISTRY_FILE = 'workspace-registry.json'

function loadRegistry(dataDir) {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, REGISTRY_FILE), 'utf-8'))
  } catch { return { titles: {}, extra: {} } }
}

function saveRegistry(dataDir, reg) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, REGISTRY_FILE), JSON.stringify(reg, null, 2))
}

/** 派生工作区列表：会话分组 + 注册表登记项 + config.workspaces 声明项。
 * ⚠️ 过滤服务数据目录与文件系统根：它们是运行时产物/无意义目录，不是可导入的项目
 * （数据目录会因无 cwd 会话兜底而出现在列表里，曾以「zcode-web-service」之名冒充同名项目，
 * 误导 Web 端导入选错路径——真实项目在仓库目录，见 config.workspaces 声明）。 */
async function deriveWorkspaces(engine, dataDir, cfg) {
  const sessions = await engine.listSessions({}).catch(() => [])
  const reg = loadRegistry(dataDir)
  const dataDirAbs = path.resolve(dataDir) + path.sep
  const hidden = (p) => {
    const abs = path.resolve(String(p))
    return abs === path.parse(dataDirAbs).root || abs === path.resolve(dataDir) || abs.startsWith(dataDirAbs)
  }
  const byPath = new Map()
  const put = (p, createdAt, updatedAt) => {
    const abs = path.resolve(String(p))
    if (hidden(abs) || byPath.has(abs)) return
    byPath.set(abs, { path: abs, sessionIds: [], createdAt, updatedAt })
  }
  for (const s of sessions) {
    const p = s.workspace?.workspacePath
    if (!p) continue
    const abs = path.resolve(p)
    if (hidden(abs)) continue
    let ws = byPath.get(abs)
    if (!ws) {
      ws = { path: abs, sessionIds: [], createdAt: s.createdAt, updatedAt: s.updatedAt }
      byPath.set(abs, ws)
    }
    ws.sessionIds.push(s.sessionId)
    ws.createdAt = Math.min(ws.createdAt, s.createdAt)
    ws.updatedAt = Math.max(ws.updatedAt, s.updatedAt)
  }
  for (const [p, meta] of Object.entries(reg.extra || {})) {
    if (!byPath.has(path.resolve(p))) {
      put(p, meta.createdAt, meta.createdAt)
    }
  }
  // config.workspaces 声明项（[{path, title?}]，目录须存在）：仓库/常用项目目录显式进列表，
  // 不依赖「恰好有会话用过该目录」
  for (const w of (Array.isArray(cfg?.workspaces) ? cfg.workspaces : [])) {
    const p = w && w.path ? path.resolve(String(w.path)) : ''
    if (p && existsSync(p)) put(p, Date.now(), Date.now())
  }
  const items = [...byPath.values()].map(ws => {
    const id = ws.path
    return {
      id,
      path: ws.path,
      title: (reg.titles || {})[id]
        || (cfg?.workspaces || []).find(w => w && path.resolve(String(w.path)) === id && w.title)?.title
        || path.basename(ws.path) || id,
      sessionIds: ws.sessionIds,
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt,
    }
  })
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return items
}

export function registerWorkspaceRoutes(router, engine, cfg, ctx) {
  const dataDir = ctx.dataDir

  router.get('/workspaces', async (_req, res) => {
    try {
      sendJson(res, 200, { ok: true, data: await deriveWorkspaces(engine, dataDir, cfg) })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  router.get('/workspaces/:id', async (_req, res, p) => {
    const items = await deriveWorkspaces(engine, dataDir, cfg).catch(() => [])
    const ws = items.find(x => x.id === p.id || x.path === p.id)
    if (!ws) return sendJson(res, 404, { ok: false, error: `Workspace '${p.id}' not found`, code: 'NOT_FOUND' })
    sendJson(res, 200, { ok: true, data: ws })
  })

  // 创建（登记）：目录必须存在；已存在则直接返回（幂等，对齐 dsh resolveByPath 语义）
  router.post('/workspaces', async (_req, res, _p, _q, body) => {
    if (!body || !body.path) return sendJson(res, 400, { ok: false, error: "Missing required parameter 'path'", code: 'BAD_REQUEST' })
    const target = path.resolve(String(body.path))
    if (!existsSync(target)) return sendJson(res, 400, { ok: false, error: `目录不存在: ${target}`, code: 'BAD_REQUEST' })
    const reg = loadRegistry(dataDir)
    reg.extra = reg.extra || {}
    const existed = Boolean(reg.extra[target])
    if (!existed) {
      reg.extra[target] = { createdAt: Date.now() }
      saveRegistry(dataDir, reg)
    }
    if (body.title?.trim()) {
      reg.titles = reg.titles || {}
      reg.titles[target] = body.title.trim()
      saveRegistry(dataDir, reg)
    }
    const items = await deriveWorkspaces(engine, dataDir, cfg)
    const ws = items.find(x => x.id === target) || {
      id: target, path: target, title: body.title?.trim() || path.basename(target), sessionIds: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    }
    sendJson(res, existed ? 200 : 201, { ok: true, data: ws })
  })

  // 修改（标题覆写）
  router.put('/workspaces/:id', async (_req, res, p, _q, body) => {
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return sendJson(res, 400, { ok: false, error: "Missing or invalid parameter 'title'", code: 'BAD_REQUEST' })
    }
    const items = await deriveWorkspaces(engine, dataDir, cfg).catch(() => [])
    const ws = items.find(x => x.id === p.id || x.path === p.id)
    if (!ws) return sendJson(res, 404, { ok: false, error: `Workspace '${p.id}' not found`, code: 'NOT_FOUND' })
    const reg = loadRegistry(dataDir)
    reg.titles = reg.titles || {}
    reg.titles[ws.id] = body.title.trim()
    saveRegistry(dataDir, reg)
    sendJson(res, 200, { ok: true, data: { ...ws, title: body.title.trim() } })
  })

  // 删除（移除登记与标题覆写；不影响会话与磁盘文件）
  router.delete('/workspaces/:id', async (_req, res, p) => {
    const reg = loadRegistry(dataDir)
    const had = Boolean(reg.extra?.[p.id])
    if (reg.extra) delete reg.extra[p.id]
    if (reg.titles) delete reg.titles[p.id]
    saveRegistry(dataDir, reg)
    sendJson(res, 200, { ok: true, data: { deleted: had || true, id: p.id } })
  })

  // 工作区下的会话
  router.get('/workspaces/:id/sessions', async (_req, res, p) => {
    const items = await deriveWorkspaces(engine, dataDir, cfg).catch(() => [])
    const ws = items.find(x => x.id === p.id || x.path === p.id)
    if (!ws) return sendJson(res, 404, { ok: false, error: `Workspace '${p.id}' not found`, code: 'NOT_FOUND' })
    const all = await engine.listSessions({}).catch(() => [])
    const ids = new Set(ws.sessionIds)
    const matched = all.filter(s => ids.has(s.sessionId))
    sendJson(res, 200, {
      ok: true,
      data: {
        workspaceId: ws.id,
        workspaceTitle: ws.title,
        sessions: matched.map(s => ({
          id: s.sessionId, title: s.title || 'Untitled Session',
          createdAt: s.createdAt, updatedAt: s.updatedAt, lastActivityAt: s.updatedAt,
        })),
      },
    })
  })
}
