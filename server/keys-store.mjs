// keys-store.mjs — 多 API Key 存储 + 管理令牌 + 失败限流。
// 对齐 dsh-web-service 的 ApiKeyStore 接口（isEnforced/verifyDataToken/touch/countActive/
// getAuthEnabled/setAuthEnabled/list/create/update/rotate/reveal/revoke/remove/ensureReady）。
// 存储文件（0600）：~/.zcode/zcode-web-service/api-keys.json（键明文本服务本地保存以支持 reveal；
// dsh 用加密存储，此处依赖文件权限，语义一致——列表仅回脱敏视图）。
// 管理令牌：~/.zcode/zcode-web-service/admin-token（48 hex，惰性生成）。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import path from 'node:path'

export class ApiKeyInputError extends Error {
  constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code }
}

export class FailureRateLimiter {
  constructor(maxFailures, windowMs) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.failures = new Map()
  }
  record(key) {
    const now = Date.now()
    const arr = (this.failures.get(key) || []).filter(t => now - t < this.windowMs)
    arr.push(now)
    this.failures.set(key, arr)
  }
  isLimited(key) {
    const now = Date.now()
    const arr = (this.failures.get(key) || []).filter(t => now - t < this.windowMs)
    this.failures.set(key, arr)
    return arr.length >= this.maxFailures
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
export function validateKeyInput(body) {
  if (!body || typeof body !== 'object') return null
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return 'name 必须是字符串'
    if (body.name.length > 64) return 'name 最长 64 个字符'
    if (CONTROL_CHARS.test(body.name)) return 'name 含非法控制字符'
  }
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return 'note 必须是字符串'
    if (body.note.length > 256) return 'note 最长 256 个字符'
    if (CONTROL_CHARS.test(body.note)) return 'note 含非法控制字符'
  }
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const d = body.expiresInDays
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > 3650) return 'expiresInDays 必须是 0 到 3650 之间的数字'
  }
  if (body.plaintext !== undefined && body.plaintext !== null) {
    if (typeof body.plaintext !== 'string') return 'plaintext 必须是字符串'
    const p = body.plaintext
    if (p.length < 16 || p.length > 256) return '自定义 Key 长度需在 16-256 个字符之间'
    if (!/^[\x21-\x7e]+$/.test(p)) return '自定义 Key 只能包含可见 ASCII 字符（不能含空格或换行）'
  }
  return null
}

export class ApiKeyStore {
  /** @param legacyKeys 配置文件里的遗留 Key（始终强制鉴权，不可管理） */
  constructor(dataDir, legacyKeys = []) {
    this.dataDir = dataDir
    this.storePath = path.join(dataDir, 'api-keys.json')
    this.adminTokenPath = path.join(dataDir, 'admin-token')
    this.legacyKeys = (legacyKeys || []).filter(k => typeof k === 'string' && k.trim())
    this.legacyEnforced = this.legacyKeys.length > 0
    this.state = { authEnabled: true, keys: [] }
    this.ready = false
    this.degraded = false
    this.degradedReason = undefined
  }

  ensureReady() {
    if (this.ready) return
    try {
      if (existsSync(this.storePath)) {
        const obj = JSON.parse(readFileSync(this.storePath, 'utf-8'))
        this.state = {
          authEnabled: obj.authEnabled !== false,
          keys: Array.isArray(obj.keys) ? obj.keys : [],
        }
      } else {
        // 首次：把遗留配置 Key 作为 legacy 记录导入（managed=false，保留明文以支持复制）
        this.state.keys = this.#legacyEntries()
        this.#persist()
      }
      // 迁移：早期版本把遗留 Key 以脱敏视图入库（丢了明文），按 id 哈希补偿重建
      for (const k of this.#legacyEntries()) {
        const idx = this.state.keys.findIndex(x => x.id === k.id)
        if (idx < 0) this.state.keys.push(k)
        else if (!this.state.keys[idx].plaintext) this.state.keys[idx] = { ...k, ...this.state.keys[idx], plaintext: k.plaintext }
      }
      this.ready = true
    } catch (e) {
      this.degraded = true
      this.degradedReason = e?.message || String(e)
      this.ready = true
    }
  }

  #legacyEntries() {
    return this.legacyKeys.map(k => ({
      id: `legacy-${createHash('sha256').update(k).digest('hex').slice(0, 8)}`,
      name: '配置文件 Key',
      plaintext: k,
      managed: false,
      status: 'active',
      createdAt: Date.now(),
    }))
  }

  #persist() {
    mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(this.storePath, JSON.stringify(this.state, null, 2))
    try { chmodSync(this.storePath, 0o600) } catch { /* best-effort */ }
  }

  isEnforced() {
    this.ensureReady()
    return this.legacyEnforced || this.state.authEnabled
  }

  getAuthEnabled() {
    this.ensureReady()
    return this.legacyEnforced || this.state.authEnabled
  }

  async setAuthEnabled(enabled) {
    this.ensureReady()
    this.state.authEnabled = enabled
    this.#persist()
  }

  countActive() {
    this.ensureReady()
    const now = Date.now()
    return this.state.keys.filter(k =>
      k.status !== 'revoked' && (!k.expiresAt || k.expiresAt > now)).length +
      (this.legacyEnforced && !this.state.keys.some(k => !k.managed) ? this.legacyKeys.length : 0)
  }

  verifyDataToken(token) {
    this.ensureReady()
    if (!token) return { ok: false }
    const now = Date.now()
    const all = [
      ...this.legacyKeys.map(k => ({ plaintext: k, id: `legacy-${createHash('sha256').update(k).digest('hex').slice(0, 8)}`, managed: false })),
      ...this.state.keys,
    ]
    for (const k of all) {
      if (!k.plaintext) continue
      if (k.status === 'revoked') continue
      if (k.expiresAt && k.expiresAt <= now) continue
      if (k.plaintext === token) {
        if (k.managed !== false || this.state.keys.includes(k)) {
          k.lastUsedAt = Date.now()
          this.#persist()
          return { ok: true, keyId: k.id }
        }
        return { ok: true, keyId: k.id }
      }
    }
    return { ok: false }
  }

  touch() { /* lastUsedAt 已在 verify 时落盘 */ }

  #view(k) {
    return {
      id: k.id,
      name: k.name || '',
      note: k.note || '',
      custom: Boolean(k.custom),
      managed: k.managed !== false,
      status: k.status || 'active',
      keyPrefix: k.plaintext ? `${k.plaintext.slice(0, 8)}…${k.plaintext.slice(-4)}` : undefined,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
    }
  }

  list(includeRevoked = true) {
    this.ensureReady()
    return this.state.keys
      .filter(k => includeRevoked || k.status !== 'revoked')
      .map(k => this.#view(k))
  }

  async create({ name, note, expiresInDays, plaintext } = {}) {
    this.ensureReady()
    let key = plaintext
    let custom = false
    if (key) custom = true
    else key = `ccws_${randomBytes(24).toString('hex')}`
    const entry = {
      id: `key-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: name || undefined,
      note: note || undefined,
      plaintext: key,
      custom,
      managed: true,
      status: 'active',
      createdAt: Date.now(),
      ...(expiresInDays ? { expiresAt: Date.now() + expiresInDays * 86400_000 } : {}),
    }
    this.state.keys.push(entry)
    this.#persist()
    return { view: this.#view(entry), plaintext: key }
  }

  #find(id) {
    return this.state.keys.find(k => k.id === id && k.managed !== false)
  }

  async update(id, { name, note, expiresAt } = {}) {
    this.ensureReady()
    const k = this.#find(id)
    if (!k) return null
    if (name !== undefined) k.name = name
    if (note !== undefined) k.note = note
    if (expiresAt !== undefined) k.expiresAt = expiresAt
    this.#persist()
    return this.#view(k)
  }

  async rotate(id) {
    this.ensureReady()
    const k = this.#find(id)
    if (!k || k.status === 'revoked') return null
    k.plaintext = `ccws_${randomBytes(24).toString('hex')}`
    k.custom = false
    k.rotatedAt = Date.now()
    this.#persist()
    return { view: this.#view(k), plaintext: k.plaintext }
  }

  async reveal(id) {
    this.ensureReady()
    // 遗留配置 Key（managed=false）的明文本就在 config.json，允许取回复制
    const k = this.state.keys.find(x => x.id === id)
    if (!k || k.status === 'revoked' || !k.plaintext) return null
    return { plaintext: k.plaintext }
  }

  async revoke(id) {
    this.ensureReady()
    const k = this.#find(id)
    if (!k || k.status === 'revoked') return null
    k.status = 'revoked'
    k.revokedAt = Date.now()
    this.#persist()
    return k
  }

  async remove(id) {
    this.ensureReady()
    const k = this.#find(id)
    if (!k || k.status !== 'revoked') return null
    this.state.keys = this.state.keys.filter(x => x.id !== id)
    this.#persist()
    return k
  }

  ensureAdminToken() {
    if (!existsSync(this.adminTokenPath)) {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.adminTokenPath, randomBytes(24).toString('hex'), { mode: 0o600 })
    }
    return readFileSync(this.adminTokenPath, 'utf-8').trim()
  }

  verifyAdminToken(token) {
    if (!token) return false
    const expect = this.ensureAdminToken()
    if (token.length !== expect.length) return false
    return createHash('sha256').update(token).digest('hex') === createHash('sha256').update(expect).digest('hex')
  }
}
