// routes/streaming.mjs — 同步对话 / SSE 流式对话 / 事件广播 / OpenAI 兼容
// （对齐 zcode-web-service streaming.ts 的路由、SSE 事件名与 OpenAI 形状）
import { randomUUID } from 'node:crypto'
import { initSseStream, sendJson } from '../http.mjs'
import path from 'node:path'

function toOpenAiUsage(usage) {
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const read = num(usage.cacheReadTokens)
  // 引擎账本 inputTokens 已含缓存读（= uncached + cacheRead + cacheWrite）
  const totalInput = num(usage.inputTokens) || num(usage.uncachedInputTokens)
  const miss = num(usage.uncachedInputTokens) || Math.max(0, totalInput - read)
  const output = num(usage.outputTokens)
  const prompt = miss + read
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: num(usage.totalTokens) || (prompt + output),
    prompt_cache_hit_tokens: read,
    prompt_cache_miss_tokens: miss,
  }
}

/** 确保会话可用于对话：给定的 id 复活（--resume），否则用 cwd 建新会话 */
async function resolvePromptSession(engine, cfg, sessionId, cwd) {
  if (sessionId) {
    await engine.resumeSession({ sessionId }).catch(() => {})
    return sessionId
  }
  const workspacePath = path.resolve(String(cwd || cfg.defaultWorkspace || cfg.dataDir || process.cwd()))
  if (!workspacePath || workspacePath === '.') throw new Error("missing 'cwd'（新建会话需要工作目录；或传 sessionId 续聊）")
  const created = await engine.createSession({ workspacePath, mode: cfg.defaultMode, model: cfg.defaultModel })
  return created.session.sessionId
}

export function registerStreamingRoutes(router, engine, cfg, ctx) {
  // 1. 同步非流式：POST /sessions/:id/prompt
  router.post('/sessions/:id/prompt', async (_req, res, p, _q, body) => {
    if (!body || !body.prompt) {
      return sendJson(res, 400, { ok: false, error: "Missing required field 'prompt'", code: 'BAD_REQUEST' })
    }
    try {
      await resolvePromptSession(engine, cfg, p.id)
      const waiter = engine.waitTurn(p.id, { timeoutMs: body.timeoutMs, stallTimeoutMs: body.stallTimeoutMs })
      await engine.sendActive(p.id, String(body.prompt))
      const result = await waiter
      sendJson(res, 200, { ok: true, data: result })
    } catch (err) {
      sendJson(res, err.message?.includes('not found') ? 404 : 500, { ok: false, error: err.message })
    }
  })

  // 2. SSE 流式对话：POST /sessions/:id/prompt-stream
  router.post('/sessions/:id/prompt-stream', async (req, res, p, _q, body) => {
    if (!body || !body.prompt) {
      return sendJson(res, 400, { ok: false, error: "Missing required field 'prompt'", code: 'BAD_REQUEST' })
    }
    const sessionId = p.id
    const sse = initSseStream(res)
    sse.send('connected', { sessionId, timestamp: Date.now() })

    // SSE 心跳：每 15s 一条注释帧，防止中间层/慢客户端空闲断流（不影响 SSE event 语义）
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* gone */ } }, 15000)

    let stallTimer = null
    // 停滞看门狗（对齐 zcode-web-service 语义）：本轮事件每来一条都重置计时，
    // 持续生成不会被超时打断；只有「无事件停滞」超过 stallGap（默认 cfg.turnStallTimeoutMs，
    // 可由 body.stallTimeoutMs 覆盖）才主动 interrupt 该轮并明确收口，SSE 不会无限悬挂。
    const stallGap = Number(body.stallTimeoutMs) > 0 ? Number(body.stallTimeoutMs)
      : (Number(cfg.turnStallTimeoutMs) > 0 ? Number(cfg.turnStallTimeoutMs) : 180_000)
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        try { engine.stopSession(sessionId).catch(() => {}) } catch { /* gone */ }
        console.error('[stream] session ' + sessionId + ' prompt-stream stalled (no events > ' + stallGap + 'ms)')
        sse.send('error', { message: 'turn stalled: no session events received for the stall timeout', code: 'TURN_TIMEOUT' })
        sse.send('done', '[DONE]')
        cleanup()
      }, stallGap)
    }
    let cleanedUp = false

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(heartbeat)
      if (stallTimer) clearTimeout(stallTimer)
      off()
      sse.close()
    }

    // 游标语义与 waitTurn 相同：订阅之后的事件才算本轮
    const cursor = engine.ringEventSeq(sessionId)
    let sawTurnStart = false
    let lastUsage = undefined
    const onEvent = ev => {
      if (ev.sessionId !== sessionId) return
      const seq = ev.seq
      if (typeof seq === 'number' && seq <= cursor) return
      armStall()
      const t = ev.type
      const pl = ev.payload || {}
      try {
        if (t === 'turn.started') { sawTurnStart = true; return }
        // 轮次终结判断必须在前：turn.completed 的 payload 里也带 usage
        if (t === 'turn.completed' || t === 'turn.failed') {
          if (!sawTurnStart) return
          if (pl && typeof pl.usage === 'object' && pl.usage !== null) sse.send('usage', { usage: pl.usage, seq })
          sse.send('turn_end', { reason: t === 'turn.failed' ? 'error' : (pl.resultType || 'completed'), seq })
          sse.send('done', '[DONE]')
          cleanup()
          return
        }
        if (t === 'model.streaming' && pl.kind === 'text_delta' && pl.delta) {
          sse.send('delta', { delta: pl.delta, seq }); return
        }
        if (t === 'model.streaming' && pl.kind === 'reasoning_delta' && pl.delta) {
          sse.send('reasoning', { delta: pl.delta, seq }); return
        }
        // 工具调用：model.streaming kind=tool_call 携带完整 input，每个调用恰一次
        if (t === 'model.streaming' && pl.kind === 'tool_call' && pl.toolCallId) {
          sse.send('tool_call', { id: pl.toolCallId, name: pl.toolName, arguments: pl.input ?? {}, seq })
          return
        }
        // 工具结果：tool.updated kind=result（result:{success,content}）
        if (t === 'tool.updated' && pl.kind === 'result' && pl.toolCallId) {
          const r = pl.result || {}
          sse.send('tool_result', {
            id: pl.toolCallId,
            result: typeof r.content === 'string' ? r.content : JSON.stringify(r ?? ''),
            isError: r.success === false,
            durationMs: undefined,
            seq,
          })
          return
        }
        if (pl && typeof pl.usage === 'object' && pl.usage !== null) {
          lastUsage = pl.usage
          sse.send('usage', { usage: pl.usage, seq })
          return
        }
        if (t === 'error' || t === 'turn.error') {
          sse.send('error', { message: pl.message || 'Execution error' })
          sse.send('done', '[DONE]')
          cleanup()
        }
      } catch { cleanup() }
    }
    engine.on('session-event', onEvent)
    const off = () => engine.off('session-event', onEvent)
    req.on('close', cleanup)
    armStall()

    try {
      await resolvePromptSession(engine, cfg, sessionId)
      await engine.sendActive(sessionId, String(body.prompt))
    } catch (err) {
      sse.send('error', { message: `Failed to admit prompt: ${err.message}` })
      cleanup()
    }
  })

  // 3. SSE 事件广播：GET /sessions/:id/events（额外支持 ?afterSeq= 断线续传与 ?live=false JSON 重放）
  router.get('/sessions/:id/events', async (req, res, p, query) => {
    const sessionId = p.id

    // JSON 重放扩展（dsh 无此参数）
    if (query.live === 'false') {
      const merged = await ctx.collectEvents(engine, sessionId, query.afterSeq != null ? Number(query.afterSeq) : null)
      return sendJson(res, 200, merged)
    }

    const sse = initSseStream(res)
    sse.send('connected', { sessionId, message: 'Subscribed to session events', timestamp: Date.now() })

    const afterSeq = query.afterSeq != null ? Number(query.afterSeq) : null
    if (afterSeq != null) {
      const merged = await ctx.collectEvents(engine, sessionId, afterSeq)
      for (const ev of merged.events) {
        sse.send('event', { seq: ev.seq, type: ev.type, data: ev.payload, time: ev.timestamp })
      }
      sse.send('replay.done', { eventSeq: merged.eventSeq, count: merged.events.length })
    }

    const onEvent = ev => {
      if (ev.sessionId !== sessionId) return
      try {
        sse.send('event', { seq: ev.seq, type: ev.type, data: ev.payload, time: ev.timestamp })
      } catch { cleanup() }
    }
    engine.on('session-event', onEvent)
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* gone */ } }, 15000)
    let cleanedUp = false
    function cleanup() {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(heartbeat)
      engine.off('session-event', onEvent)
      sse.close()
    }
    req.on('close', cleanup)
  })

  // 4. OpenAI 兼容：POST /chat/completions
  router.post('/chat/completions', async (req, res, _p, _q, body) => {
    try {
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return sendJson(res, 400, { ok: false, error: "Invalid request: 'messages' array is required and must not be empty", code: 'BAD_REQUEST' })
      }
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user')
      if (!lastUserMsg) return sendJson(res, 400, { ok: false, error: 'No user message found in messages', code: 'BAD_REQUEST' })
      const promptText = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : String(lastUserMsg.content)

      const completionId = `chatcmpl-${randomUUID()}`
      const createdTime = Math.floor(Date.now() / 1000)
      const modelName = body.model || 'claude-model'

      const sessionId = await resolvePromptSession(engine, cfg, body.sessionId, body.cwd)

      // 临时指定模型：兼容 provider/model 与纯 model id 两种写法
      if (body.model) {
        const modelId = String(body.model).includes('/') ? String(body.model).split('/').slice(1).join('/') : String(body.model)
        if (modelId) await engine.setModel(sessionId, modelId).catch(() => {})
      }

      // 流式
      if (body.stream) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders?.()

        // SSE 心跳：注释帧防止中间层空闲断流（OpenAI 客户端按 SSE 规范忽略注释行）
        const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* gone */ } }, 15000)

        let cleanedUp = false
        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearInterval(heartbeat)
          engine.off('session-event', onEvent)
          res.end()
        }

        const cursor = engine.ringEventSeq(sessionId)
        let sawTurnStart = false
        const onEvent = ev => {
          if (ev.sessionId !== sessionId) return
          if (typeof ev.seq === 'number' && ev.seq <= cursor) return
          const t = ev.type
          const pl = ev.payload || {}
          let deltaText = ''
          if (t === 'turn.started') { sawTurnStart = true; return }
          if (t === 'model.streaming' && pl.kind === 'text_delta') deltaText = pl.delta || ''
          if (deltaText) {
            const chunk = {
              id: completionId, object: 'chat.completion.chunk', created: createdTime,
              model: modelName, sessionId,
              choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            return
          }
          if ((t === 'turn.completed' || t === 'turn.failed') && sawTurnStart) {
            const finalChunk = {
              id: completionId, object: 'chat.completion.chunk', created: createdTime,
              model: modelName, sessionId,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
            res.write('data: [DONE]\n\n')
            cleanup()
          }
        }
        engine.on('session-event', onEvent)
        req.on('close', () => { cleanedUp = true; clearInterval(heartbeat); engine.off('session-event', onEvent) })

        await engine.sendActive(sessionId, promptText)
        return
      }

      // 非流式：执行并等待
      const waiter = engine.waitTurn(sessionId, { timeoutMs: body.timeoutMs, stallTimeoutMs: body.stallTimeoutMs })
      await engine.sendActive(sessionId, promptText)
      const result = await waiter
      const usage = result.usage ? toOpenAiUsage(result.usage) : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created: createdTime,
        model: modelName,
        sessionId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.content, reasoning_content: result.reasoning },
          finish_reason: 'stop',
        }],
        usage,
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })
}
