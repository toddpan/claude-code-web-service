// engine.mjs — Claude Code 会话引擎（每会话一个 `claude -p` 长驻进程，stream-json 双向 stdio）。
//
// Wire format（实测于 Claude Code CLI 2.1.215，与官方 Agent SDK 同一协议）：
//   - stdin:  {"type":"user","message":{"role":"user","content":"..." | [parts]}}
//             {"type":"control_response","response":{"subtype":"success","request_id":X,"response":{behavior:"allow"|"deny",...}}}
//             {"type":"control_request","request_id":X,"request":{"subtype":"interrupt"|"set_permission_mode"|"set_model",...}}
//   - stdout: {"type":"system","subtype":"init",...session_id/model/tools/skills}
//             {"type":"stream_event","event":{...anthropic 流事件}}        （--include-partial-messages）
//             {"type":"assistant","message":{content:[text|thinking|tool_use]}}
//             {"type":"user","message":{content:[tool_result]}}
//             {"type":"result","subtype":"success",result,usage,duration_ms,total_cost_usd}
//             {"type":"control_request","request_id":X,"request":{"subtype":"can_use_tool",tool_name,input}}
//   - 会话持久化：--resume <sessionId> 续接；transcript 落盘 ~/.claude/projects/<cwd-slug>/<id>.jsonl
//
// 与 ZCode 引擎（单 app-server 多路复用）不同：这里维护「会话进程注册表」，
// 空闲回收、崩溃自动 --resume 复活都在引擎层处理。对外仍暴露与 zcode-web-service
// engine 相同的方法面（createSession/sendActive/waitTurn/listQuestions/...），
// 事件也折叠成同一内部事件族（turn.started / model.streaming / tool.updated /
// turn.completed / turn.failed），路由层因此几乎不需要改动。
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** 触发问答桥的工具：走 user_input 批次而不是普通授权 */
const ASK_TOOL = 'AskUserQuestion'

export class EngineError extends Error {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.data = data
  }
}

/** dsh/zcode 风格权限预设 → Claude Code 权限模式（路由层也用它做别名归一） */
export const PERMISSION_PRESET_ALIASES = {
  'danger-full-access': 'bypassPermissions',
  'full-access': 'bypassPermissions',
  'full': 'bypassPermissions',
  'yolo': 'bypassPermissions',
  'workspace-write': 'acceptEdits',
  'build': 'acceptEdits',
  'edit': 'acceptEdits',
  'acceptEdits': 'acceptEdits',
  'read-only': 'plan',
  'plan': 'plan',
  'ask': 'default',
  'default': 'default',
  'auto': 'acceptEdits',
  'guarded': 'default',
}

// ---------------------------------------------------------------------------

class ClaudeSession {
  /**
   * @param {ClaudeEngine} engine
   * @param {object} opts cwd 必填；resumeId 提供时以 --resume 续接
   */
  constructor(engine, { cwd, resumeId, mode, model, effort, name, publicId } = {}) {
    this.engine = engine
    this.cwd = cwd
    this.resumeId = resumeId || null
    /** 服务侧公开会话 id（API 全程用这个；claude 真实 id 首轮 prompt 后才存在） */
    this.publicId = publicId || resumeId || null
    /** Claude 真实 session id（init 事件到达后才有；用于 --resume 与 transcript 定位） */
    this.claudeId = resumeId || null
    this.requestedMode = mode || 'default'
    this.model = model || ''
    this.effort = effort || ''
    this.name = name || ''
    this.alive = false
    this.child = null
    this.stdin = null
    this.turnActive = false
    /** 每条 assistant 消息前累积的 delta 计数（用于全量 assistant 事件去重） */
    this.deltas = { text: 0, thinking: 0 }
    this.stderrTail = []
    this.initWaiter = null
    this.closeTimer = null
  }

  start(timeoutMs = 5_000) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
    ]
    if (this.engine.streamPartial) args.push('--include-partial-messages')
    if (this.requestedMode && this.requestedMode !== 'default') args.push('--permission-mode', this.requestedMode)
    if (this.resumeId) args.push('--resume', this.resumeId)
    if (this.model) args.push('--model', this.model)
    if (this.effort) args.push('--effort', this.effort)
    if (this.name) args.push('--name', this.name)
    this.engine.log('info', `claude spawn: ${this.engine.claudeBin} ${args.join(' ')} (cwd=${this.cwd})`)

    const child = spawn(this.engine.claudeBin, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeEnv(),
    })
    this.child = child
    this.alive = true

    let stdoutBuf = ''
    child.stdout.on('data', d => {
      stdoutBuf += d.toString('utf8')
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (line.trim()) this.#handleLine(line)
      }
      if (stdoutBuf.length > 1 << 20) stdoutBuf = ''
    })
    child.stderr.on('data', d => {
      const s = d.toString('utf8')
      this.stderrTail.push(s)
      if (this.stderrTail.length > 50) this.stderrTail.shift()
      if (s.trim()) this.engine.log('info', `claude stderr: ${s.trim().slice(0, 300)}`)
    })
    child.on('exit', (code, signal) => {
      this.alive = false
      this.child = null
      const tail = (this.stderrTail || []).join('').trim()
      if (tail) this.engine.log('warn', `claude exited code=${code} signal=${signal} stderr: ${tail.slice(-500)}`)
      else this.engine.log('warn', `claude exited code=${code} signal=${signal} session=${this.publicId}/${this.claudeId}`)
      if (this.publicId) this.engine.onSessionProcessExit(this.publicId, this)
    })

    // 注意：--input-format stream-json 模式下，claude 在收到第一条 stdin 消息前
    // 不输出任何事件（含 system/init），因此这里只等「spawn 成功 + 短宽限期无早退」，
    // 真实 session id 由 onSystem 在首轮 prompt 后捕获。
    return new Promise((resolve, reject) => {
      const crash = (why) => {
        clearTimeout(grace)
        const tail = (this.stderrTail || []).join('').trim()
        reject(new EngineError(`claude exited during startup (${why}): ${tail.slice(-300)}`, { code: 'ENGINE_EXITED' }))
      }
      const onExitEarly = (code, signal) => crash(`code=${code} signal=${signal}`)
      child.once('exit', onExitEarly)
      const grace = setTimeout(() => {
        child.off('exit', onExitEarly)
        resolve({ publicId: this.publicId, claudeId: this.claudeId })
      }, timeoutMs)
    })
  }

  #handleLine(line) {
    let raw
    try { raw = JSON.parse(line) } catch {
      this.engine.log('warn', `non-JSON claude line dropped: ${line.slice(0, 120)}`)
      return
    }
    switch (raw.type) {
      case 'system': this.#onSystem(raw); break
      case 'stream_event': this.#onStreamEvent(raw); break
      case 'assistant': this.#onAssistant(raw); break
      case 'user': this.#onUser(raw); break
      case 'result': this.#onResult(raw); break
      case 'control_request': this.#onControlRequest(raw); break
      case 'control_response': this.#onControlResponse(raw); break
      case 'control_cancel_request': {
        const rid = raw.request_id || raw.id
        if (rid) this.engine.dropInteraction(String(rid))
        break
      }
      default: break // stream_event 之外的未知类型静默
    }
  }

  #onSystem(raw) {
    if (raw.session_id) {
      const first = !this.claudeId
      this.claudeId = raw.session_id
      if (raw.model) this.model = raw.model
      if (raw.permissionMode) this.requestedMode = raw.permissionMode
      if (first) {
        // 真实 id 回填索引：--resume / transcript 定位都靠它
        this.engine.touchIndex(this.publicId, { claudeId: this.claudeId, model: this.model })
      }
    }
  }

  #onStreamEvent(raw) {
    const ev = raw.event || {}
    if (ev.type !== 'content_block_delta') return
    const delta = ev.delta || {}
    if (delta.type === 'text_delta' && delta.text) {
      this.deltas.text += 1
      this.engine.pushEvent(this.publicId, 'model.streaming', { kind: 'text_delta', delta: delta.text })
    } else if (delta.type === 'thinking_delta' && delta.thinking) {
      this.deltas.thinking += 1
      this.engine.pushEvent(this.publicId, 'model.streaming', { kind: 'reasoning_delta', delta: delta.thinking })
    }
  }

  #onAssistant(raw) {
    const msg = raw.message || {}
    const blocks = Array.isArray(msg.content) ? msg.content : []
    const sawText = this.deltas.text > 0
    const sawThinking = this.deltas.thinking > 0
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.id) {
        this.engine.pushEvent(this.publicId, 'model.streaming', {
          kind: 'tool_call', toolCallId: b.id, toolName: b.name, input: b.input ?? {},
        })
      } else if (b.type === 'text' && b.text && !sawText) {
        this.engine.pushEvent(this.publicId, 'model.streaming', { kind: 'text_delta', delta: b.text })
      } else if (b.type === 'thinking' && b.thinking && !sawThinking) {
        this.engine.pushEvent(this.publicId, 'model.streaming', { kind: 'reasoning_delta', delta: b.thinking })
      }
    }
    this.deltas.text = 0
    this.deltas.thinking = 0
  }

  #onUser(raw) {
    const msg = raw.message || {}
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const b of blocks) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      let content = ''
      if (typeof b.content === 'string') content = b.content
      else if (Array.isArray(b.content)) {
        content = b.content.map(x => (x.type === 'text' ? x.text : JSON.stringify(x))).join('\n')
      } else if (b.content) content = JSON.stringify(b.content)
      this.engine.pushEvent(this.publicId, 'tool.updated', {
        kind: 'result', toolCallId: b.tool_use_id,
        result: { success: !b.is_error, content },
      })
    }
  }

  #onResult(raw) {
    this.turnActive = false
    const usage = mapUsage(raw.usage)
    const modelUsage = raw.modelUsage || {}
    const ctxWindow = Object.values(modelUsage)[0]?.contextWindow
    // CLI 内部空轮（task-notification）：不算用户轮次
    const originKind = raw.origin?.kind
    if (originKind === 'task-notification' && !raw.num_turns && !raw.result) return
    if (raw.subtype === 'compact' || raw.subtype === 'compaction') {
      this.engine.pushEvent(this.publicId, 'turn.completed', { resultType: 'compact', response: raw.result || '', usage })
      return
    }
    if (raw.subtype === 'success' || raw.is_error === false) {
      this.engine.pushEvent(this.publicId, 'turn.completed', {
        response: raw.result || '',
        usage,
        durationMs: raw.duration_ms,
        ttftMs: raw.ttft_ms,
        numTurns: raw.num_turns,
        costUsd: raw.total_cost_usd,
        contextWindow: ctxWindow,
        resultType: raw.subtype || 'completed',
      })
    } else {
      this.engine.pushEvent(this.publicId, 'turn.failed', {
        message: raw.result || raw.subtype || 'claude result error',
        usage,
        durationMs: raw.duration_ms,
        costUsd: raw.total_cost_usd,
      })
    }
    this.engine.touchIndex(this.publicId, { updatedAt: Date.now() })
  }

  /** 我们发出的 control_request（interrupt/set_permission_mode/set_model）的应答 */
  #onControlResponse(raw) {
    const resp = raw.response || {}
    const requestId = String(resp.request_id || '')
    if (!requestId) return
    const pending = this.engine.controlPending.get(requestId)
    if (!pending) return
    this.engine.controlPending.delete(requestId)
    clearTimeout(pending.timer)
    if (resp.subtype === 'error') pending.reject(new EngineError(resp.error || 'control request failed', { code: 'CONTROL_ERROR' }))
    else pending.resolve(resp.response ?? resp)
  }

  #onControlRequest(raw) {
    const req = raw.request || {}
    const subtype = req.subtype
    const requestId = String(raw.request_id || raw.id || '')
    if (!requestId) return
    // 我们自己发出的 control_request 的应答
    const pending = this.engine.controlPending.get(requestId)
    if (pending) {
      this.engine.controlPending.delete(requestId)
      clearTimeout(pending.timer)
      if (req.subtype === 'error') pending.reject(new EngineError(req.error || 'control request failed', { code: 'CONTROL_ERROR' }))
      else pending.resolve(req)
      return
    }
    if (subtype !== 'can_use_tool') {
      // hook_callback 等其他反向请求：给空应答避免挂死
      this.writeJSON({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } })
      return
    }
    const toolName = req.tool_name || ''
    const input = req.input || {}
    // AskUserQuestion 恒走问答桥（bypass 模式下也保留交互）
    if (toolName === ASK_TOOL) {
      this.engine.surfaceInteraction(this, requestId, 'user_input', toolName, input, parseQuestions(input))
      return
    }
    const decision = this.#autoDecide(toolName)
    if (decision) {
      this.writeJSON({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } } })
      return
    }
    this.engine.surfaceInteraction(this, requestId, 'permission', toolName, input, [])
  }

  /** 权限模式自动放行策略（对齐 cc-connect：bypass 全放行，acceptEdits 只放行编辑类） */
  #autoDecide(toolName) {
    if (this.requestedMode === 'bypassPermissions') return true
    if (this.requestedMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true
    return false
  }

  writeJSON(v) {
    if (!this.stdin && this.child) this.stdin = this.child.stdin
    if (!this.stdin || this.alive === false) throw new EngineError('claude process is not running', { code: 'NOT_RUNNING' })
    this.stdin.write(JSON.stringify(v) + '\n')
  }

  send(text) {
    this.turnActive = true
    this.deltas.text = 0
    this.deltas.thinking = 0
    this.engine.pushEvent(this.publicId, 'turn.started', { input: text })
    this.writeJSON({ type: 'user', message: { role: 'user', content: text } })
  }

  respondPermission(requestId, behavior, message, updatedInput) {
    const payload = behavior === 'allow'
      ? { behavior: 'allow', updatedInput: updatedInput || {} }
      : { behavior: 'deny', message: message || "The user denied this tool use. Stop and wait for the user's instructions." }
    return this.writeJSON({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: payload } })
  }

  controlRequest(subtype, params = {}, timeoutMs = 10_000) {
    const requestId = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.engine.controlPending.delete(requestId)
        reject(new EngineError(`control request timeout: ${subtype}`, { code: 'TIMEOUT' }))
      }, timeoutMs)
      this.engine.controlPending.set(requestId, { resolve, reject, timer })
      try {
        this.writeJSON({ type: 'control_request', request_id: requestId, request: { subtype, ...params } })
      } catch (e) {
        clearTimeout(timer)
        this.engine.controlPending.delete(requestId)
        reject(e)
      }
    })
  }

  interrupt() {
    if (!this.alive || !this.turnActive) return Promise.resolve()
    return this.controlRequest('interrupt').catch(() => {})
  }

  /** 分级收口：stdin end → SIGTERM → SIGKILL（对齐 cc-connect 的进程树清理经验） */
  close({ timeoutMs = 4000 } = {}) {
    if (!this.child) { this.alive = false; return }
    const child = this.child
    try { child.stdin.end() } catch { /* gone */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 2000)
    }, timeoutMs)
    child.once('exit', () => clearTimeout(killTimer))
    this.alive = false
  }
}

// ---------------------------------------------------------------------------

export class ClaudeEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.claudeBin   claude 可执行文件（绝对路径或 PATH 名）
   * @param {string} opts.dataDir     服务数据目录（sessions-index.json 所在）
   * @param {string} [opts.cwd]       引擎默认 cwd（会话各带 workspace）
   * @param {(level,msg,extra?)=>void} opts.log
   * @param {string} [opts.defaultMode]  新会话缺省权限模式
   * @param {string} [opts.defaultModel] 新会话缺省模型
   * @param {boolean} [opts.streamPartial] 是否 --include-partial-messages（token 级流式）
   * @param {number} [opts.sessionIdleTimeoutMs] 空闲进程回收（0=不回收）
   * @param {number} [opts.maxSessions] 并发会话进程上限
   */
  constructor({
    claudeBin = 'claude', cwd, dataDir, log = () => {}, requestTimeoutMs = 120_000,
    defaultMode = 'default', defaultModel = '', streamPartial = true,
    sessionIdleTimeoutMs = 30 * 60_000, maxSessions = 32, interactionTimeoutMs = 10 * 60_000,
    turnStallTimeoutMs = 180_000,
  } = {}) {
    super()
    this.claudeBin = claudeBin
    this.cwd = cwd
    this.dataDir = dataDir
    this.log = log
    this.requestTimeoutMs = requestTimeoutMs
    this.defaultMode = MODES.has(defaultMode) ? defaultMode : 'default'
    this.defaultModel = defaultModel
    this.streamPartial = streamPartial !== false
    this.sessionIdleTimeoutMs = Number(sessionIdleTimeoutMs) >= 0 ? Number(sessionIdleTimeoutMs) : 30 * 60_000
    this.maxSessions = Number(maxSessions) > 0 ? Number(maxSessions) : 32
    this.interactionTimeoutMs = interactionTimeoutMs
    this.turnStallTimeoutMs = Number(turnStallTimeoutMs) > 0 ? Number(turnStallTimeoutMs) : 180_000

    /** sessionId -> ClaudeSession（活跃进程） */
    this.sessions = new Map()
    /** alias -> in-flight spawn promise（并发启动去重） */
    this.starting = new Map()
    /** sessionId -> 持久元数据 {title,cwd,mode,model,effort,createdAt,updatedAt} */
    this.index = new Map()
    /** sessionId -> {events:[], eventSeq:0}（内存 ring，与 zcode 引擎同构） */
    this.ring = new Map()
    this.ringLimit = 4000
    /** sessionId -> {mode}（权限模式当前值） */
    this.modeState = new Map()
    /** requestId -> {resolve,reject,timer}（自身 control_request 的应答） */
    this.controlPending = new Map()
    /** requestId -> 挂起问答/授权批次（对齐 zcode engine.interactions） */
    this.interactions = new Map()

    this.#loadIndex()
    this.idleTimer = this.sessionIdleTimeoutMs > 0
      ? setInterval(() => this.#reapIdle(), Math.min(60_000, this.sessionIdleTimeoutMs / 2)).unref()
      : null
  }

  get running() { return true } // 服务进程本身即引擎宿主（对齐 system/status 字段语义）

  ensureReady() { return Promise.resolve() }

  stop() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    for (const s of this.sessions.values()) s.close({ timeoutMs: 1000 })
  }

  // ---- index 持久化 --------------------------------------------------------

  #indexPath() { return path.join(this.dataDir, 'sessions-index.json') }

  #loadIndex() {
    try {
      const obj = JSON.parse(readFileSync(this.#indexPath(), 'utf-8'))
      for (const [id, meta] of Object.entries(obj.sessions || {})) this.index.set(id, meta)
    } catch { /* 首次无文件 */ }
  }

  #persistIndex() {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.#indexPath(), JSON.stringify({ sessions: Object.fromEntries(this.index) }, null, 2))
    } catch (e) { this.log('warn', `persist index failed: ${e.message}`) }
  }

  touchIndex(sessionId, patch) {
    const meta = this.index.get(sessionId) || {}
    Object.assign(meta, patch)
    this.index.set(sessionId, meta)
    this.#persistIndex()
  }

  // ---- 事件 ring -----------------------------------------------------------

  pushEvent(sessionId, type, payload = {}) {
    if (!sessionId) return
    let entry = this.ring.get(sessionId)
    if (!entry) { entry = { events: [], eventSeq: 0 }; this.ring.set(sessionId, entry) }
    entry.eventSeq += 1
    const ev = {
      sessionId,
      seq: entry.eventSeq,
      eventId: `${sessionId}:${entry.eventSeq}`,
      type,
      payload,
      timestamp: Date.now(),
    }
    entry.events.push(ev)
    if (entry.events.length > this.ringLimit) entry.events.splice(0, entry.events.length - this.ringLimit)
    this.emit('session-event', ev)
  }

  ringEventSeq(sessionId) { return this.ring.get(sessionId)?.eventSeq ?? 0 }

  // ---- 会话生命周期 ---------------------------------------------------------

  async createSession({ workspacePath, mode, model, thoughtLevel, title, sessionId } = {}) {
    if (!workspacePath) throw new EngineError('workspacePath is required', { code: 'INVALID_PARAMS' })
    if (this.sessions.size >= this.maxSessions) {
      throw new EngineError(`concurrent session limit reached (${this.maxSessions})`, { code: 'TOO_MANY_SESSIONS' })
    }
    const effective = MODES.has(mode) ? mode : this.defaultMode
    // 公开 id：显式传 sessionId（接管场景）否则服务生成；claude 真实 id 首轮 prompt 后回填
    const publicId = sessionId || `cc-${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const session = new ClaudeSession(this, {
      cwd: path.resolve(workspacePath),
      resumeId: sessionId || undefined,
      publicId,
      mode: effective,
      model: model || this.defaultModel || '',
      effort: thoughtLevel || '',
      name: title || '',
    })
    await this.#startOnce(publicId, () => session)
    this.modeState.set(publicId, { mode: session.requestedMode })
    const now = Date.now()
    this.touchIndex(publicId, {
      title: title || '', cwd: session.cwd, mode: session.requestedMode,
      model: session.model, effort: session.effort, createdAt: now, updatedAt: now,
      ...(session.claudeId ? { claudeId: session.claudeId } : {}),
    })
    return {
      session: {
        sessionId: publicId,
        engineSessionId: session.claudeId || undefined,
        title: title || '',
        mode: session.requestedMode,
        workspace: { workspacePath: session.cwd },
        createdAt: now,
        updatedAt: now,
      },
      requestedMode: session.requestedMode,
    }
  }

  /** 入参可能是公开 id 或 claude 真实 id，统一解析为公开 id */
  #resolveAlias(sessionId) {
    if (this.sessions.has(sessionId)) return sessionId
    if (this.index.has(sessionId)) return sessionId
    for (const [alias, meta] of this.index) {
      if (meta.claudeId === sessionId) return alias
    }
    return sessionId
  }

  /** 复活/接管会话：活跃则直接返回；否则按索引 cwd 以 --resume（真实 id）重启进程。 */
  async resumeSession({ sessionId, workspacePath } = {}) {
    if (!sessionId) throw new EngineError('sessionId is required', { code: 'INVALID_PARAMS' })
    const alias = this.#resolveAlias(sessionId)
    const s0 = this.sessions.get(alias)
    if (s0?.alive) return { sessionId: alias }
    const meta = this.index.get(alias) || {}
    const cwd = workspacePath || meta.cwd
    if (!cwd) throw new EngineError(`Session '${alias}' not found`, { code: 'NOT_FOUND' })
    if (this.sessions.has(alias)) this.sessions.delete(alias)
    if (this.sessions.size >= this.maxSessions) this.#reapOldest()
    // 有真实 claude id 才 --resume；从未 prompt 过的会话直接起新进程
    const resumeId = meta.claudeId || undefined
    const session = new ClaudeSession(this, {
      cwd: path.resolve(cwd),
      resumeId,
      publicId: alias,
      mode: meta.mode || this.defaultMode,
      model: meta.model || this.defaultModel || '',
      effort: meta.effort || '',
    })
    await this.#startOnce(alias, () => session)
    this.modeState.set(alias, { mode: session.requestedMode })
    this.touchIndex(alias, { updatedAt: Date.now() })
    return { sessionId: alias }
  }

  /**
   * 并发启动去重：同一 alias 的 spawn 只进行一次（首个 in-flight promise 复用给
   * 后续调用），避免重复 claude 进程泄漏。
   */
  #startOnce(alias, makeSession) {
    const inflight = this.starting.get(alias)
    if (inflight) return inflight
    const session = makeSession()
    const p = session.start().then(() => {
      this.sessions.set(alias, session)
    }).finally(() => {
      this.starting.delete(alias)
    })
    this.starting.set(alias, p)
    return p
  }

  onSessionProcessExit(sessionId, session) {
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
    this.pushEvent(sessionId, 'session.exited', {})
  }

  /** 空闲进程回收：进程退出不影响会话历史，下次 prompt 自动 --resume 复活 */
  #reapIdle() {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      const ring = this.ring.get(id)
      const last = ring?.events.at(-1)?.timestamp || 0
      if (last && now - last > this.sessionIdleTimeoutMs) {
        this.log('info', `reaping idle session process ${id}`)
        s.close()
        this.sessions.delete(id)
      }
    }
  }

  #reapOldest() {
    let oldestId = null
    let oldestAt = Infinity
    for (const [id, s] of this.sessions) {
      const last = this.ring.get(id)?.events.at(-1)?.timestamp || 0
      if (last < oldestAt) { oldestAt = last; oldestId = id }
    }
    if (oldestId) {
      this.sessions.get(oldestId)?.close()
      this.sessions.delete(oldestId)
    }
  }

  // ---- 对话 ------------------------------------------------------------

  async send(sessionId, content) {
    const s = this.#live(sessionId)
    s.send(content)
  }

  /** 发送消息；进程不在（空闲回收/崩溃）时自动 --resume 复活后重试。 */
  async sendActive(sessionId, content) {
    try {
      return await this.send(sessionId, content)
    } catch (e) {
      if (e.code !== 'NOT_RUNNING') throw e
      await this.resumeSession({ sessionId })
      return this.send(sessionId, content)
    }
  }

  /**
   * 等待一轮完成并收集文本/思考/工具调用/token 账本。
   * 游标与停滞看门狗语义与 zcode-web-service engine.waitTurn 完全一致：
   * 每条新事件重置计时，只有持续无事件停滞超过 stallGap 才收口（interrupt 后
   * 返回已收集的部分内容，附 stalled: true，不 reject）。
   */
  waitTurn(sessionId, { timeoutMs = 0, stallTimeoutMs } = {}) {
    const stallGap = Number(stallTimeoutMs) > 0 ? Number(stallTimeoutMs)
      : Number(timeoutMs) > 0 ? Number(timeoutMs)
      : (this.turnStallTimeoutMs || 180_000)
    return new Promise(resolve => {
      const cursor = this.ringEventSeq(sessionId)
      let content = ''
      let reasoning = ''
      let toolCalls = []
      let usage
      let sawTurnStart = false
      let settled = false
      let timer = null

      const finish = result => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.off('session-event', onEvent)
        resolve({
          content: (result?.response ?? content).trim(),
          reasoning: reasoning || undefined,
          toolCalls,
          usage,
          resultType: result?.resultType,
          costUsd: result?.costUsd,
          durationMs: result?.durationMs,
          stalled: result?.stalled === true,
        })
      }

      const armStall = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          try { this.stopSession(sessionId).catch(() => {}) } catch { /* gone */ }
          finish({ response: content, stalled: true })
        }, stallGap)
      }

      const onEvent = ev => {
        if (ev.sessionId !== sessionId) return
        if (typeof ev.seq === 'number' && ev.seq <= cursor) return
        armStall()
        const t = ev.type
        const p = ev.payload || {}
        if (t === 'turn.started') { sawTurnStart = true; return }
        if (t === 'model.streaming' && p.kind === 'text_delta') { content += p.delta || ''; return }
        if (t === 'model.streaming' && p.kind === 'reasoning_delta') { reasoning += p.delta || ''; return }
        if (t === 'model.streaming' && p.kind === 'tool_call' && p.toolCallId) {
          toolCalls.push({ id: p.toolCallId, name: p.toolName, arguments: p.input ?? {} })
          return
        }
        if (t === 'tool.updated' && p.kind === 'result' && p.toolCallId) {
          const r = p.result || {}
          const last = [...toolCalls].reverse().find(x => x.id === p.toolCallId)
          if (last) {
            last.result = typeof r.content === 'string' ? r.content : JSON.stringify(r ?? '')
            last.isError = r.success === false
          }
          return
        }
        if (p && typeof p.usage === 'object' && p.usage !== null) usage = p.usage
        if (t === 'turn.completed' || t === 'turn.failed') {
          if (!sawTurnStart) return
          finish(p)
        }
      }

      armStall()
      this.on('session-event', onEvent)
    })
  }

  /** 取消当前轮次（interrupt control request）。 */
  async stopSession(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s || !s.alive) return { stopped: true, alreadyIdle: true }
    await s.interrupt()
    return { stopped: true }
  }

  async closeSession(sessionId) {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.close()
      this.sessions.delete(sessionId)
    }
    this.ring.delete(sessionId)
    this.modeState.delete(sessionId)
    for (const [rid, it] of this.interactions) {
      if (it.sessionId === sessionId) this.dropInteraction(rid)
    }
    this.index.delete(sessionId)
    this.persistIndex()
    return { closed: true }
  }

  // ---- 查询 ------------------------------------------------------------

  async listSessions() {
    const now = Date.now()
    const out = []
    for (const [id, meta] of this.index) {
      const live = this.sessions.get(id)?.alive
      out.push({
        sessionId: id,
        title: meta.title || '',
        createdAt: meta.createdAt || now,
        updatedAt: meta.updatedAt || meta.createdAt || now,
        workspace: { workspacePath: meta.cwd },
        status: live ? 'running' : 'idle',
        mode: this.modeState.get(id)?.mode || meta.mode || 'default',
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  readSession(sessionId) {
    const meta = this.index.get(sessionId)
    const live = this.sessions.get(sessionId)
    if (!meta && !live) throw new EngineError(`Session '${sessionId}' not found`, { code: 'NOT_FOUND' })
    const s = live && live.alive ? live : undefined
    return {
      session: {
        sessionId,
        title: meta?.title || '',
        createdAt: meta?.createdAt,
        updatedAt: meta?.updatedAt,
        workspace: { workspacePath: s?.cwd || meta?.cwd },
        mode: this.modeState.get(sessionId)?.mode || meta?.mode || 'default',
        status: live ? 'running' : 'idle',
      },
      settings: {
        model: { current: { providerId: 'anthropic', modelId: s?.model || meta?.model || this.defaultModel || '' } },
      },
      todos: null,
    }
  }

  sessionCwd(sessionId) {
    const s = this.#liveOrThrowSoft(sessionId)
    return s?.cwd || this.index.get(sessionId)?.cwd || undefined
  }

  #live(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s || !s.alive) throw new EngineError(`session '${sessionId}' process is not running`, { code: 'NOT_RUNNING' })
    return s
  }

  // ---- 模式 / 模型 / 计划 / 压缩 --------------------------------------------

  async setMode(sessionId, mode) {
    if (!MODES.has(mode)) throw new EngineError(`mode must be one of ${[...MODES].join('/')}`, { code: 'INVALID_PARAMS' })
    this.modeState.set(sessionId, { mode })
    this.touchIndex(sessionId, { mode })
    const s = this.#liveOrThrowSoft(sessionId)
    let appliedLive = true
    let liveNote
    if (s) {
      try {
        await s.controlRequest('set_permission_mode', { mode })
      } catch (e) {
        // CLI 限制：bypassPermissions 只能在启动时授予（--permission-mode），中途切换被拒；
        // 记入索引，下次 resume（带 --permission-mode）生效
        appliedLive = false
        liveNote = e.message
        this.log('warn', `set_permission_mode ${mode} deferred to next resume: ${e.message}`)
      }
      s.requestedMode = mode
    } else {
      appliedLive = false
      liveNote = 'session process not running; mode applied on next resume'
    }
    return { sessionId, mode, appliedLive, liveNote }
  }

  /** 进程不在线时返回 undefined（模式已记入索引，下次 spawn 生效），不抛错 */
  #liveOrThrowSoft(sessionId) {
    const s = this.sessions.get(sessionId)
    return s && s.alive ? s : undefined
  }

  async setPlanMode(sessionId, active) {
    const st = this.modeState.get(sessionId) || this.index.get(sessionId) || {}
    const base = st.mode && MODES.has(st.mode) && st.mode !== 'plan' ? st.mode : 'default'
    return this.setMode(sessionId, active ? 'plan' : base)
  }

  async setModel(sessionId, model) {
    this.touchIndex(sessionId, { model })
    const s = this.#liveOrThrowSoft(sessionId)
    if (s) {
      try { await s.controlRequest('set_model', { model }) } catch (e) {
        this.log('warn', `set_model ${model} failed (applied on next resume): ${e.message}`)
      }
      s.model = model
    }
    return { sessionId, model }
  }

  async setEffort(sessionId, effort) {
    this.touchIndex(sessionId, { effort })
    const s = this.#liveOrThrowSoft(sessionId)
    if (s) {
      try { await s.controlRequest('set_effort', { effort }) } catch (e) {
        this.log('warn', `set_effort ${effort} failed (applied on next resume): ${e.message}`)
      }
      s.effort = effort
    }
    return { sessionId, effort }
  }

  async renameSession(sessionId, title) {
    this.touchIndex(sessionId, { title })
    const s = this.#liveOrThrowSoft(sessionId)
    if (s) {
      try { await this.send(sessionId, `/rename ${title}`) } catch (e) {
        this.log('warn', `rename via /rename failed: ${e.message}`)
      }
    }
    return { sessionId, title }
  }

  /** 手动压缩（异步受理：发会话内 /compact 斜杠命令，等价 ZCode session/compact accepted）。 */
  async compactSession(sessionId, instructions) {
    await this.sendActive(sessionId, instructions ? `/compact ${instructions}` : '/compact')
    return { compact: { state: 'accepted' } }
  }

  effectiveMode(sessionId) {
    return this.modeState.get(sessionId)?.mode || this.index.get(sessionId)?.mode || null
  }

  // ---- 问答桥（权限 / AskUserQuestion） -------------------------------------

  surfaceInteraction(session, requestId, kind, toolName, input, questions) {
    const entry = {
      msgId: requestId,
      method: kind === 'user_input' ? 'claude/askUserQuestion' : 'claude/canUseTool',
      kind,
      params: { toolName, input },
      sessionId: session.publicId,
      toolName,
      input,
      questions: questions || [],
      at: Date.now(),
    }
    this.interactions.set(requestId, entry)
    entry.timer = setTimeout(() => {
      if (this.interactions.delete(requestId)) {
        this.log('warn', `interaction ${kind} timed out, auto-denying session=${entry.sessionId}`)
        try { session.respondPermission(requestId, 'deny', 'Permission request timed out (10 minutes).') } catch { /* gone */ }
      }
    }, this.interactionTimeoutMs)
    this.emit('interaction', entry)
  }

  dropInteraction(requestId) {
    const it = this.interactions.get(requestId)
    if (!it) return
    clearTimeout(it.timer)
    this.interactions.delete(requestId)
  }

  /** 挂起的问答/授权批次（形状对齐 zcode engine.listQuestions） */
  listQuestions(sessionId) {
    const out = []
    for (const it of this.interactions.values()) {
      if (sessionId && it.sessionId !== sessionId) continue
      out.push({
        batchId: String(it.msgId),
        kind: it.kind === 'user_input' ? 'user_input' : 'permission',
        at: it.at,
        sessionId: it.sessionId,
        prompt: undefined,
        toolName: it.toolName,
        interaction: undefined,
        questions: Array.isArray(it.questions) ? it.questions : [],
      })
    }
    return out
  }

  /**
   * 答复挂起批次。接受两种形状（对齐 zcode engine.answerQuestion）：
   *  - 原生形式 {action:'accept'|'decline', reason?}：accept=allow（保持原 input），decline=deny
   *  - dsh 兼容形式 {answers:[{id, selected[], custom?}]}：
   *      AskUserQuestion → allow，把每题答案注入 updatedInput.questions[i].answer
   *      普通授权        → 有实际答复即 allow，否则 deny
   */
  answerQuestion(batchId, body) {
    const it = this.interactions.get(batchId)
    if (!it) return { ok: false, code: 'NOT_FOUND', error: `批次 ${batchId} 不存在或已答复` }
    const session = this.sessions.get(it.sessionId)
    if (!session || !session.alive) {
      this.dropInteraction(batchId)
      return { ok: false, code: 'NOT_FOUND', error: '会话进程已退出，批次失效' }
    }
    let respond
    if (body && typeof body === 'object' && Array.isArray(body.answers)) {
      const answers = body.answers.map(a => ({
        id: String(a?.id ?? ''),
        selected: Array.isArray(a?.selected) ? a.selected.map(String) : [],
        ...(typeof a?.custom === 'string' && a.custom ? { custom: a.custom } : {}),
      }))
      const meaningful = answers.some(a => a.selected.length > 0 || a.custom)
      if (it.kind === 'user_input') {
        if (!meaningful) {
          this.dropInteraction(batchId)
          try { session.respondPermission(batchId, 'deny', 'User skipped the question.') } catch { /* gone */ }
          return { ok: true, batchId, answered: { action: 'decline' } }
        }
        // CLI 期望的 updatedInput 形状（对齐 cc-connect buildAskQuestionResponse）：
        // { questions: [...原样...], answers: { "<问题原文>": "<答案文本>" } }
        const qs = it.input?.questions || []
        const updatedInput = JSON.parse(JSON.stringify(it.input || {}))
        const answerMap = {}
        answers.forEach((a, i) => {
          const q = qs[i] || qs.find(x => (x.header || x.question) === a.id)
          const text = q?.question || a.id
          answerMap[text] = a.custom || a.selected.join('、')
        })
        updatedInput.answers = answerMap
        this.dropInteraction(batchId)
        try { session.respondPermission(batchId, 'allow', undefined, updatedInput) } catch (e) {
          return { ok: false, code: 'ENGINE_ERROR', error: e.message }
        }
        return { ok: true, batchId, answered: { action: 'accept', answers } }
      }
      respond = meaningful ? 'allow' : 'deny'
      this.dropInteraction(batchId)
      try {
        session.respondPermission(batchId, respond, meaningful ? undefined : (body?.reason || 'all answers empty'),
          meaningful ? it.input : undefined)
      } catch (e) { return { ok: false, code: 'ENGINE_ERROR', error: e.message } }
      return { ok: true, batchId, answered: { action: respond } }
    }
    if (body && typeof body === 'object' && typeof body.action === 'string') {
      const behavior = body.action === 'accept' ? 'allow' : 'deny'
      this.dropInteraction(batchId)
      try {
        session.respondPermission(batchId, behavior,
          behavior === 'deny' ? (body.reason || body.content || undefined) : undefined,
          behavior === 'allow' ? it.input : undefined)
      } catch (e) { return { ok: false, code: 'ENGINE_ERROR', error: e.message } }
      return { ok: true, batchId, answered: { action: body.action } }
    }
    return { ok: false, code: 'BAD_REQUEST', error: '需要 {action,...} 或 {answers:[...]} 形状的答复' }
  }

  // ---- 历史 / 统计 / todos（transcript 兜底） --------------------------------

  /** 在 ~/.claude/projects 下定位会话 transcript（sessionId 全局唯一，扫目录即可） */
  findTranscript(sessionId) {
    const root = process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
      : path.join(os.homedir(), '.claude', 'projects')
    if (!existsSync(root)) return undefined
    const directSlug = (p) => path.join(root, String(p).replace(/\//g, '-'), `${sessionId}.jsonl`)
    if (this.index.get(sessionId)?.cwd) {
      const p = directSlug(this.index.get(sessionId).cwd)
      if (existsSync(p)) return p
    }
    try {
      for (const dir of readdirSync(root)) {
        const p = path.join(root, dir, `${sessionId}.jsonl`)
        if (existsSync(p)) return p
      }
    } catch { /* gone */ }
    return undefined
  }

  /** transcript 折叠成内部事件（服务重启后 ring 为空时的历史兜底） */
  async transcriptEvents(sessionId) {
    const file = this.findTranscript(sessionId)
    if (!file) return []
    let raw
    try { raw = readFileSync(file, 'utf-8') } catch { return [] }
    const events = []
    let seq = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.isSidechain) continue
      const msg = rec.message || {}
      if (rec.type === 'user' && typeof msg.content === 'string') {
        seq += 1
        events.push({ sessionId, seq, eventId: `t:${seq}`, type: 'turn.started', payload: { input: msg.content }, timestamp: rec.timestamp ? Date.parse(rec.timestamp) : undefined })
      } else if (rec.type === 'assistant' && Array.isArray(msg.content)) {
        const text = msg.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('')
        if (text) {
          seq += 1
          events.push({ sessionId, seq, eventId: `t:${seq}`, type: 'session.updated', payload: { content: text, stopReason: 'end_turn' }, timestamp: rec.timestamp ? Date.parse(rec.timestamp) : undefined })
        }
      }
    }
    return events
  }
}

// ---------------------------------------------------------------------------

/** 过滤嵌套检测环境变量（服务可能跑在 claude 会话里），保留 ANTHROPIC_* 等鉴权变量 */
function claudeEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k === 'CLAUDE_CODE_SSE_PORT') continue
    env[k] = v
  }
  return env
}

function mapUsage(u) {
  if (!u || typeof u !== 'object') return undefined
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const input = num(u.input_tokens)
  const cacheRead = num(u.cache_read_input_tokens)
  const cacheCreation = num(u.cache_creation_input_tokens)
    || num(u.cache_creation?.ephemeral_5m_input_tokens) + num(u.cache_creation?.ephemeral_1h_input_tokens)
  const output = num(u.output_tokens)
  return {
    inputTokens: input + cacheRead + cacheCreation,
    uncachedInputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheCreation,
    outputTokens: output,
    totalTokens: input + cacheRead + cacheCreation + output,
  }
}

/** AskUserQuestion 工具 input.questions → dsh 问答形状 */
function parseQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : []
  return qs.map((q, i) => ({
    id: String(q.header || `q${i + 1}`),
    question: String(q.question || ''),
    header: q.header ? String(q.header) : undefined,
    options: (Array.isArray(q.options) ? q.options : []).map((o, j) => ({
      id: String(o.label || `o${j + 1}`),
      label: String(o.label || ''),
      description: o.description ? String(o.description) : undefined,
    })),
    multiSelect: !!q.multiSelect,
  }))
}
