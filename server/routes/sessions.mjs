// routes/sessions.mjs — 会话管理全套（对齐 zcode-web-service sessions.ts 的路由与形状）
import path from 'node:path'
import os from 'node:os'
import { sendJson } from '../http.mjs'
import { resolveSkillRoot, discoverSkills } from '../util.mjs'
import { MODES, PERMISSION_PRESET_ALIASES } from '../engine.mjs'

/** 配置级缺省模型 cfg.defaultModel（claude 模型 id，如 sonnet / claude-opus-4-5） */
function defaultModelRef(cfg) {
  const raw = String(cfg?.defaultModel || '').trim()
  return raw || undefined
}

function titleOf(s) { return s.title || 'Untitled Session' }
function statusOf(s) { return s.status === 'running' ? 'running' : 'idle' }

/** 从事件流折叠会话历史消息（对齐 zcode-web-service /sessions/:id/history 的形状） */
function foldHistory(events, maxMessages, beforeSeq) {
  const messages = []
  for (const ev of events) {
    if (beforeSeq !== undefined && typeof ev.seq === 'number' && ev.seq >= beforeSeq) continue
    const t = ev.type
    const p = ev.payload || {}
    if (t === 'turn.started' && typeof p.input === 'string') {
      messages.push({ seq: ev.seq, type: 'user/message', role: 'user', content: p.input, time: ev.timestamp })
    } else if (p && typeof p.content === 'string' && p.stopReason) {
      // 模型单次调用完成的 assistant 消息（session.updated 载荷）
      messages.push({ seq: ev.seq, type: 'assistant/message', role: 'assistant', content: p.content, time: ev.timestamp })
    } else if (t === 'turn.completed' && typeof p.response === 'string' && p.response && p.response !== messages.at(-1)?.content) {
      messages.push({ seq: ev.seq, type: 'assistant/message', role: 'assistant', content: p.response, time: ev.timestamp })
    }
  }
  const total = messages.length
  return { messages: messages.slice(-maxMessages), hasMore: total > maxMessages, totalMessages: total, totalEvents: events.length }
}

/** 从事件流折叠会话统计（对齐 zcode-web-service /sessions/:id/stats 的形状，尽力而为字段） */
function foldStats(events) {
  const out = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    costUsd: 0,
  }
  const turnStarts = new Set()
  for (const ev of events) {
    const p = ev.payload || {}
    if (ev.type === 'turn.started') turnStarts.add(p.turnNumber ?? ev.seq)
    if (ev.type === 'model.streaming' && p.kind === 'tool_call') out.steps += 1
    if (ev.type === 'turn.completed') {
      out.turns += 1
      out.llmMs += Number(p.durationMs) || 0
      out.costUsd += Number(p.costUsd) || 0
      if (p.ttftMs) { out.ttftMs = out.ttftMs || Number(p.ttftMs); out.ttftSteps += 1 }
      const u = p.usage
      if (u && typeof u === 'object') {
        out.usage.inputTokens += Number(u.inputTokens) || 0
        out.usage.cacheReadTokens += Number(u.cacheReadTokens) || 0
        out.usage.cacheWriteTokens += Number(u.cacheWriteTokens) || 0
        out.usage.outputTokens += Number(u.outputTokens) || 0
      }
    }
  }
  if (out.turns === 0) out.turns = turnStarts.size
  return out
}

export function registerSessionRoutes(router, engine, cfg, ctx) {
  // 1. 会话列表（?search= &workspaceId= &limit= &includeArchived=）
  router.get('/sessions', async (_req, res, _p, query) => {
    try {
      let list = await engine.listSessions({
        includeArchived: query.includeArchived === 'true',
        limit: query.limit ? Number(query.limit) : undefined,
      })
      if (query.search?.trim()) {
        const kw = query.search.trim().toLowerCase()
        list = list.filter(s => (s.title || '').toLowerCase().includes(kw) || String(s.sessionId).toLowerCase().includes(kw))
      }
      if (query.workspaceId) list = list.filter(s => s.workspace?.workspacePath === query.workspaceId)
      const items = list.map(s => ({
        id: s.sessionId,
        title: titleOf(s),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastActivityAt: s.updatedAt,
        workspaceId: s.workspace?.workspacePath,
        status: statusOf(s),
        mode: s.mode,
      }))
      sendJson(res, 200, { ok: true, data: items })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 2. 会话详情
  router.get('/sessions/:id', async (_req, res, p) => {
    try {
      const detail = engine.readSession(p.id)
      const s = detail?.session
      if (!s) return sendJson(res, 404, { ok: false, error: `Session '${p.id}' not found`, code: 'NOT_FOUND' })
      const cur = detail?.settings?.model?.current
      sendJson(res, 200, {
        ok: true,
        data: {
          id: s.sessionId,
          title: titleOf(s),
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          workspaceId: s.workspace?.workspacePath,
          status: statusOf(s),
          model: cur ? { provider: cur.providerId, model: cur.modelId, reasoningEffort: undefined } : undefined,
          mode: s.mode,
          effectiveMode: engine.effectiveMode(p.id),
          eventCount: engine.ring.get(p.id)?.events.length,
          cwd: s.workspace?.workspacePath,
        },
      })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 404 : 500, { ok: false, error: err.message, code: err.code === 'NOT_FOUND' ? 'NOT_FOUND' : undefined })
    }
  })

  // 3. 创建会话
  router.post('/sessions', async (_req, res, _p, _q, body) => {
    try {
      // 缺省目录兜底：defaultWorkspace → 用户主目录（对齐 zcode-web-service）
      const cwd = body?.cwd || body?.workspacePath || body?.workspaceId || cfg.defaultWorkspace || os.homedir()
      if (!cwd) return sendJson(res, 400, { ok: false, error: "Missing required parameter 'cwd'（或 workspacePath/workspaceId）", code: 'BAD_REQUEST' })
      const workspacePath = path.resolve(String(cwd))
      const requestedMode = body?.mode && MODES.has(body.mode) ? body.mode
        : body?.permission ? (PERMISSION_PRESET_ALIASES[String(body.permission)] || cfg.defaultMode)
        : cfg.defaultMode
      const result = await engine.createSession({
        workspacePath,
        mode: requestedMode,
        model: body?.model || defaultModelRef(cfg),
        thoughtLevel: body?.reasoningEffort,
        title: body?.title,
        sessionId: body?.sessionId,
      })
      const s = result.session
      sendJson(res, 201, {
        ok: true,
        data: {
          permission: { sessionId: s.sessionId, preset: result.requestedMode, available: [...MODES] },
          sessionId: s.sessionId,
          title: body?.title || titleOf(s) || 'Untitled Session',
          workspaceId: s.workspace?.workspacePath,
          mode: s.mode,
          requestedMode: result.requestedMode,
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message, code: err.code })
    }
  })

  // 4. 修改会话（标题/模型/推理强度/权限模式）
  router.put('/sessions/:id', async (_req, res, p, _q, body) => {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'Empty update payload', code: 'BAD_REQUEST' })
    const updates = {}
    try {
      if (body.title !== undefined) {
        // Claude Code 支持会话内 /rename；同时落服务索引
        const result = await engine.renameSession(p.id, String(body.title).trim()).catch(e => { throw e })
        updates.title = { applied: true, title: result?.title }
      }
      if (body.model) {
        // provider 字段仅为形状兼容（Claude 只有 anthropic），模型以 body.model 为准
        const model = String(body.model).includes('/') ? String(body.model).split('/').slice(1).join('/') : String(body.model)
        try {
          await engine.setModel(p.id, model)
          updates.model = { provider: 'anthropic', model }
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: `setModel failed: ${e.message}` })
        }
      }
      if (body.reasoningEffort) {
        try { await engine.setEffort(p.id, String(body.reasoningEffort)) } catch (e) {
          return sendJson(res, 500, { ok: false, error: `setEffort failed: ${e.message}` })
        }
        updates.thoughtLevel = String(body.reasoningEffort)
      }
      if (body.agentPreset !== undefined || body.permission !== undefined) {
        const raw = String(body.agentPreset ?? body.permission ?? '').trim()
        const mode = PERMISSION_PRESET_ALIASES[raw] || (MODES.has(raw) ? raw : undefined)
        if (mode) {
          await engine.setMode(p.id, mode).catch(() => {})
          updates.preset = { id: raw, applied: true, mode }
        } else {
          updates.preset = { id: raw || undefined, applied: false, reason: 'unknown-preset' }
        }
      }
      sendJson(res, 200, { ok: true, data: { sessionId: p.id, ...updates } })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 404 : 500, { ok: false, error: err.message })
    }
  })

  // 5. 删除/关闭会话
  router.delete('/sessions/:id', async (_req, res, p) => {
    try {
      await engine.closeSession(p.id)
      sendJson(res, 200, { ok: true, data: { deleted: true, sessionId: p.id } })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message })
    }
  })

  // 6. 会话历史（?maxMessages= &beforeSeq=）
  router.get('/sessions/:id/history', async (_req, res, p, query) => {
    try {
      const maxMessages = query.maxMessages ? parseInt(query.maxMessages, 10) : 50
      const beforeSeq = query.beforeSeq !== undefined ? parseInt(query.beforeSeq, 10) : undefined
      const merged = await ctx.collectEvents(engine, p.id, null)
      const folded = foldHistory(merged.events, maxMessages, beforeSeq)
      sendJson(res, 200, { ok: true, data: { sessionId: p.id, ...folded } })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6.5 会话统计
  router.get('/sessions/:id/stats', async (_req, res, p) => {
    try {
      const merged = await ctx.collectEvents(engine, p.id, null)
      const stats = foldStats(merged.events)
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id,
          ...stats,
          billedInputTokens: stats.usage.inputTokens + stats.usage.cacheReadTokens + stats.usage.cacheWriteTokens,
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6.6 任务清单（从事件流的 TodoWrite/TaskCreate/TaskUpdate 折叠，尽力而为）
  router.get('/sessions/:id/todos', async (_req, res, p) => {
    try {
      const merged = await ctx.collectEvents(engine, p.id, null)
      let todos = []
      for (const ev of merged.events) {
        const pl = ev.payload || {}
        if (ev.type !== 'model.streaming' || pl.kind !== 'tool_call') continue
        if (pl.toolName === 'TodoWrite' && Array.isArray(pl.input?.todos)) {
          todos = pl.input.todos
        } else if (pl.toolName === 'TaskCreate' && (pl.input?.subject || pl.input?.description)) {
          todos = [...todos, { content: pl.input.subject || pl.input.description, status: 'pending' }]
        } else if (pl.toolName === 'TaskUpdate') {
          const idx = Number(pl.input?.taskId)
          if (Number.isInteger(idx) && todos[idx - 1]) {
            todos = todos.map((t, i) => (i === idx - 1 ? { ...t, status: pl.input.status || t.status } : t))
          }
        }
      }
      todos = todos
        .filter(x => typeof x?.content === 'string' && x.content.trim())
        .map(x => ({
          content: x.content.trim(),
          status: x.status === 'in_progress' || x.status === 'completed' ? x.status : 'pending',
        }))
      const now = Date.now()
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id,
          todos,
          updatedAt: null,
          turnStartedAt: null,
          turnEndedAt: null,
          lastEventAt: null,
          running: false,
          elapsedMs: 0,
          turns: 0,
          counts: {
            completed: todos.filter(x => x.status === 'completed').length,
            inProgress: todos.filter(x => x.status === 'in_progress').length,
            pending: todos.filter(x => x.status === 'pending').length,
          },
          serverTime: now,
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
  })

  // 6.7 会话作用域技能目录（?root= &cwd= &search=）
  router.get('/sessions/:id/skills', async (_req, res, p, query) => {
    try {
      const cwd = engine.sessionCwd(p.id)
      const resolved = resolveSkillRoot(query.root || 'user', query.cwd || cwd, cfg.customSkillDirs || [])
      if (!resolved.ok) return sendJson(res, 400, { ok: false, error: resolved.error, code: 'BAD_REQUEST' })
      const root = resolved.root
      const skills = await discoverSkills(root.path)
      const kw = (query.search || '').trim().toLowerCase()
      const filtered = kw ? skills.filter(x => x.name.toLowerCase().includes(kw) || x.description.toLowerCase().includes(kw)) : skills
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id,
          cwd: cwd || undefined,
          root: { kind: root.kind, path: root.path },
          count: filtered.length,
          skills: filtered.map(x => ({
            name: x.name, description: x.description, whenToUse: x.whenToUse,
            modelInvocable: x.modelInvocable, userInvocable: x.userInvocable,
          })),
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
  })

  // 6b. 运行权限（映射到 Claude Code 权限模式）
  router.get('/sessions/:id/permission', async (_req, res, p) => {
    try {
      const detail = engine.readSession(p.id)
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id,
          preset: engine.effectiveMode(p.id) || detail?.session?.mode || 'default',
          sandbox: undefined,
          approval: undefined,
          available: [...MODES],
        },
      })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 404 : 500, { ok: false, error: err.message })
    }
  })

  router.put('/sessions/:id/permission', async (_req, res, p, _q, body) => {
    const preset = String(body?.preset || '').trim()
    if (!preset) return sendJson(res, 400, { ok: false, error: 'preset is required', code: 'BAD_REQUEST' })
    const mode = PERMISSION_PRESET_ALIASES[preset] || (MODES.has(preset) ? preset : undefined)
    if (!mode) return sendJson(res, 400, { ok: false, error: `unknown preset "${preset}" (available: default/acceptEdits/plan/bypassPermissions + dsh aliases)`, code: 'UNKNOWN_PRESET' })
    try {
      const result = await engine.setMode(p.id, mode)
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id, preset, mode,
          effectiveMode: engine.effectiveMode(p.id),
          available: [...MODES],
          appliedLive: result.appliedLive !== false,
          ...(result.appliedLive === false && result.liveNote ? { note: result.liveNote } : {}),
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6c. 会话协作（目标 / 计划模式 / 压缩）——形状对齐 zcode-web-service；
  //     Claude Code 无目标运行时（goal 恒 null / 动作 400），plan 映射权限模式，compact 走 /compact

  router.get('/sessions/:id/goal', async (_req, res, p) => {
    try {
      engine.readSession(p.id)
      sendJson(res, 200, { ok: true, data: { goal: null } })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 409 : 500, { ok: false, error: err.message, code: err.code === 'NOT_FOUND' ? 'SESSION_NOT_LIVE' : undefined })
    }
  })

  router.post('/sessions/:id/goal', async (_req, res, _p, _q, body) => {
    const objective = typeof body?.objective === 'string' ? body.objective.trim() : ''
    if (!objective) return sendJson(res, 400, { ok: false, error: 'objective is required', code: 'INVALID_INPUT' })
    return sendJson(res, 400, {
      ok: false,
      error: 'claude-code 无目标运行时（ZCode session/goal 专有）；可改用 POST /sessions/:id/prompt 下发目标文本',
      code: 'GOAL_UNSUPPORTED',
    })
  })

  router.put('/sessions/:id/goal', async (_req, res, _p, _q, body) => {
    const rawAction = String(body?.action || '').trim()
    const mapped = { edit: 'replace', replace: 'replace', set: 'set', pause: 'pause', resume: 'resume', clear: 'clear' }[rawAction]
    if (!mapped) {
      return sendJson(res, 400, {
        ok: false,
        error: `action must be one of edit | replace | set | pause | resume | clear（complete/blocked/disarm 无对应操作）`,
        code: 'INVALID_INPUT',
      })
    }
    return sendJson(res, 400, {
      ok: false,
      error: 'claude-code 无目标运行时（ZCode session/goal 专有），全部目标动作不可用',
      code: 'GOAL_UNSUPPORTED',
    })
  })

  // 计划模式：映射 Claude Code 权限模式 plan ⇄ 基础模式；转换立即生效（无排队）
  router.get('/sessions/:id/plan', async (_req, res, p) => {
    try {
      engine.readSession(p.id)
      const mode = engine.effectiveMode(p.id) || 'default'
      sendJson(res, 200, { ok: true, data: { active: mode === 'plan', pending: false, baseMode: mode !== 'plan' ? mode : undefined } })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 409 : 500, { ok: false, error: err.message, code: err.code === 'NOT_FOUND' ? 'SESSION_NOT_LIVE' : undefined })
    }
  })

  router.put('/sessions/:id/plan', async (_req, res, p, _q, body) => {
    if (typeof body?.active !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: 'active (boolean) is required', code: 'INVALID_INPUT' })
    }
    try {
      const before = engine.effectiveMode(p.id)
      const already = (before === 'plan') === body.active
      if (!already) await engine.setPlanMode(p.id, body.active)
      const cur = engine.effectiveMode(p.id)
      sendJson(res, 200, {
        ok: true,
        data: {
          active: body.active,
          pending: false,
          transition: already ? 'noop' : 'committed',
          baseMode: cur && cur !== 'plan' ? cur : undefined,
        },
      })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 409 : 500, { ok: false, error: err.message, code: err.code === 'NOT_FOUND' ? 'SESSION_NOT_LIVE' : undefined })
    }
  })

  // 压缩：发会话内 /compact，异步受理（accepted）
  router.post('/sessions/:id/compact', async (_req, res, p, _q, body) => {
    const instructions = typeof body?.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : undefined
    try {
      const result = await engine.compactSession(p.id, instructions)
      const state = result?.compact?.state || 'accepted'
      sendJson(res, 200, { ok: true, data: { compacted: true, state, response: result?.response } })
    } catch (err) {
      sendJson(res, err.code === 'NOT_FOUND' ? 409 : 500, { ok: false, error: err.message, code: err.code === 'NOT_FOUND' ? 'SESSION_NOT_LIVE' : undefined })
    }
  })

  // 7. 取消当前轮次（interrupt control request）
  router.post('/sessions/:id/cancel', async (_req, res, p) => {
    try {
      let result
      try {
        result = await engine.stopSession(p.id)
      } catch (e) {
        result = { stopped: true, alreadyIdle: true }
      }
      sendJson(res, 200, { ok: true, data: { cancelled: true, sessionId: p.id, ...(result || {}) } })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 8. APP 任务索引登记（ZCode APP 专有；形状对齐，恒 501）
  router.get('/sessions/:id/app-registration', async (_req, res, p) => {
    return sendJson(res, 501, { ok: false, error: 'app task index registration disabled (claude-code 无 ZCode APP 任务索引)', code: 'DISABLED' })
  })
  router.put('/sessions/:id/app-registration', async (_req, res, p) => {
    return sendJson(res, 501, { ok: false, error: 'app task index registration disabled (claude-code 无 ZCode APP 任务索引)', code: 'DISABLED' })
  })
  router.delete('/sessions/:id/app-registration', async (_req, res, p) => {
    return sendJson(res, 501, { ok: false, error: 'app task index registration disabled (claude-code 无 ZCode APP 任务索引)', code: 'DISABLED' })
  })
}
