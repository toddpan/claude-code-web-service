// routes/keys.mjs — API Key 管理（设置页 + 管理接口，对齐 dsh api-keys.ts）
// 管理面鉴权：回环免令牌直接管理；跨源拒绝；adminRemoteAccess 放开的远程请求仍需
// X-Admin-Token/Bearer 管理令牌（令牌只对非回环生效），并保留失败限流。
import { sendJson } from '../http.mjs'
import { FailureRateLimiter, validateKeyInput } from '../keys-store.mjs'
import { generateApiKeysHtml } from './keys-page.mjs'
import { collectLanIpv4 } from '../netinfo.mjs'
import { createServer as createNetServer } from 'node:net'

const adminFailLimiter = new FailureRateLimiter(10, 60_000)

function clientIp(req) { return req.socket?.remoteAddress || 'unknown' }

function isLoopback(req) {
  const addr = clientIp(req)
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

function isCrossOrigin(req) {
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || !origin) return false
  const host = req.headers['host']
  if (typeof host !== 'string' || !host) return true
  try { return new URL(origin).host !== host } catch { return true }
}

function extractToken(req, headerName, bearer) {
  const authHeader = req.headers['authorization']
  if (bearer && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim()
  const raw = req.headers[headerName]
  return typeof raw === 'string' ? raw.trim() : ''
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
}

async function rejectAdmin(req, res, store, opts) {
  noStore(res)
  const ip = clientIp(req)
  if (isCrossOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden: cross-origin request rejected', code: 'FORBIDDEN_ORIGIN' })
    return true
  }
  if (!opts.adminRemoteAccess && !isLoopback(req)) {
    sendJson(res, 403, {
      ok: false,
      error: 'Forbidden: API Key 管理接口仅允许本机（回环）访问。确需远程管理时，请在配置中设置 adminRemoteAccess: true。',
      code: 'FORBIDDEN_REMOTE',
    })
    return true
  }
  store.ensureReady()
  // 本机（回环）请求免管理令牌：同用户本机进程本就读得到令牌文件，令牌在本机只是摩擦。
  // 管理令牌只在远程管理（adminRemoteAccess: true 且来源非回环）时校验。
  if (!isLoopback(req)) {
    if (adminFailLimiter.isLimited(ip)) {
      sendJson(res, 429, { ok: false, error: 'Too many failed admin authentication attempts, please retry later', code: 'RATE_LIMITED' })
      return true
    }
    const token = extractToken(req, 'x-admin-token', true)
    if (!store.verifyAdminToken(token)) {
      adminFailLimiter.record(ip)
      sendJson(res, 401, {
        ok: false,
        error: `Unauthorized: 远程管理需要管理令牌（Admin Token）。令牌存放于 ${store.adminTokenPath} 文件（在运行本服务的那台机器上查看）。`,
        code: 'ADMIN_UNAUTHORIZED',
      })
      return true
    }
  }
  return false
}

export function registerApiKeyRoutes(router, cfg, store) {
  const guardOpts = { adminRemoteAccess: cfg.adminRemoteAccess === true }

  // 设置页（公开，页面本身不含密钥）
  router.get('/settings/api-keys', (_req, res, _p, query) => {
    noStore(res)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(generateApiKeysHtml(cfg.pathPrefix || '/api/v1', store.adminTokenPath, query.embed === '1', cfg.serviceVersion))
  }, { auth: 'public' })

  // ---------- API 服务状态（对齐 dsh-web-service v0.5.0 service-settings）----------
  // zcode-web-service 本体就是常驻独立服务（launchd 托管），没有「主端口 + 独立端口」之分：
  // state 恒 running，端口即 cfg.port；start/stop 属进程托管操作，API 层拒绝并给出 launchctl 指引。
  function serviceState() {
    const bindIp = cfg.bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
    const prefix = cfg.pathPrefix || '/api/v1'
    const port = Number(cfg.port) || 3081
    const urls = [`http://127.0.0.1:${port}${prefix}`]
    if (bindIp === '0.0.0.0') {
      for (const ip of collectLanIpv4()) {
        const url = `http://${ip}:${port}${prefix}`
        if (!urls.includes(url)) urls.push(url)
      }
    }
    return {
      running: true,
      port,
      bindIp,
      listeningPort: port,
      lanIps: collectLanIpv4(),
      urls,
      exposedToLan: bindIp === '0.0.0.0',
      autoStart: true,
      manager: 'launchd',
    }
  }

  /** 建议一个空闲端口（设置页「自动」参考）：cfg.port+1 起扫描，全占用时交系统分配 */
  function suggestPort(bindIp) {
    const probe = port => new Promise(resolve => {
      const s = createNetServer()
      const done = free => { try { s.close() } catch { /* ignore */ } resolve(free) }
      s.once('error', () => done(false))
      s.listen(port, bindIp === '0.0.0.0' ? undefined : bindIp, () => done(true))
    })
    return (async () => {
      const start = (Number(cfg.port) || 3081) + 1
      for (let i = 0; i < 100; i++) {
        if (await probe(start + i)) return start + i
      }
      return new Promise(resolve => {
        const s = createNetServer()
        s.once('error', () => resolve(0))
        s.listen(0, bindIp === '0.0.0.0' ? undefined : bindIp, () => {
          const addr = s.address()
          const port = addr && typeof addr === 'object' ? addr.port : 0
          s.close(() => resolve(port))
        })
      })
    })()
  }

  router.get('/api-keys/service', async (req, res) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    sendJson(res, 200, { ok: true, data: serviceState() })
  }, { auth: 'admin' })

  router.get('/api-keys/service/free-port', async (req, res) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    const port = await suggestPort(serviceState().bindIp)
    sendJson(res, 200, { ok: true, data: { port, bindIp: serviceState().bindIp } })
  }, { auth: 'admin' })

  // 兼容 dsh 旧端点：GET /api-keys/port = /api-keys/service
  router.get('/api-keys/port', async (req, res) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    sendJson(res, 200, { ok: true, data: serviceState() })
  }, { auth: 'admin' })

  // 启停是 launchd 的职责（plist KeepAlive 托管）：API 内无法「停止后仍可达」，
  // 拒绝并给出等价的 launchctl 命令。
  router.post('/api-keys/service/start', async (req, res) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    sendJson(res, 501, {
      ok: false,
      error: '服务由 launchd 托管且已在运行（能收到本请求即说明监听正常）。重启请执行 launchctl kickstart -k gui/$(id -u)/com.zcode.webservice；改端口请编辑 config.json 后重启。',
      code: 'SERVICE_PROCESS_MANAGED',
    })
  }, { auth: 'admin' })

  router.post('/api-keys/service/stop', async (req, res) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    sendJson(res, 501, {
      ok: false,
      error: '服务由 launchd 托管（KeepAlive），停止请执行 launchctl bootout gui/$(id -u)/com.zcode.webservice；直接杀进程会被自动拉起。',
      code: 'SERVICE_PROCESS_MANAGED',
    })
  }, { auth: 'admin' })

  // 列表
  router.get('/api-keys', async (req, res, _p, query) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    store.ensureReady()
    const includeRevoked = query.includeRevoked !== 'false'
    sendJson(res, 200, {
      ok: true,
      data: {
        authEnabled: store.getAuthEnabled(),
        authEnforcedByConfig: store.legacyEnforced,
        activeKeyCount: store.countActive(),
        storeDegraded: store.degraded,
        storeDegradedReason: store.degradedReason || undefined,
        keys: store.list(includeRevoked),
      },
    })
  }, { auth: 'admin' })

  // 新建
  router.post('/api-keys', async (req, res, _p, _q, body) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    const bad = validateKeyInput(body)
    if (bad) return sendJson(res, 400, { ok: false, error: bad, code: 'BAD_REQUEST' })
    try {
      const input = body && typeof body === 'object' ? body : {}
      const created = await store.create({
        name: typeof input.name === 'string' ? input.name : undefined,
        note: typeof input.note === 'string' ? input.note : undefined,
        expiresInDays: typeof input.expiresInDays === 'number' ? input.expiresInDays : undefined,
        plaintext: typeof input.plaintext === 'string' ? input.plaintext : undefined,
      })
      sendJson(res, 201, {
        ok: true,
        data: {
          key: created.view,
          plaintext: created.plaintext,
          warning: created.view.custom
            ? '这是你自行指定的 Key；请立即保存，本服务只在列表中保留可复制的一份。'
            : '完整 Key 之后仍可在列表中「复制」，但建议现在就存到安全的地方。',
        },
      })
    } catch (err) {
      if (err instanceof Error && err.code) return sendJson(res, 400, { ok: false, error: err.message, code: err.code })
      sendJson(res, 503, { ok: false, error: 'Key 存储写入失败，本次没有产生 Key，也未改变任何既有 Key 的状态。', code: 'KEYS_STORE_UNAVAILABLE' })
    }
  }, { auth: 'admin' })

  // 改名/过期
  router.patch('/api-keys/:id', async (req, res, p, _q, body) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    const bad = validateKeyInput(body)
    if (bad) return sendJson(res, 400, { ok: false, error: bad, code: 'BAD_REQUEST' })
    try {
      const patch = body && typeof body === 'object' ? body : {}
      const updated = await store.update(p.id, {
        name: typeof patch.name === 'string' ? patch.name : undefined,
        note: typeof patch.note === 'string' ? patch.note : undefined,
        expiresAt: patch.expiresAt === null ? null : typeof patch.expiresAt === 'number' ? patch.expiresAt : undefined,
      })
      if (!updated) return sendJson(res, 404, { ok: false, error: 'Key 不存在，或该 Key 来自插件配置、不支持修改', code: 'KEY_NOT_FOUND' })
      sendJson(res, 200, { ok: true, data: updated })
    } catch {
      sendJson(res, 503, { ok: false, error: 'Key 存储写入失败，本次修改没有生效。', code: 'KEYS_STORE_UNAVAILABLE' })
    }
  }, { auth: 'admin' })

  // 轮换
  router.post('/api-keys/:id/rotate', async (req, res, p) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    try {
      const rotated = await store.rotate(p.id)
      if (!rotated) return sendJson(res, 404, { ok: false, error: 'Key 不存在，或该 Key 来自插件配置、不支持轮换', code: 'KEY_NOT_FOUND' })
      sendJson(res, 200, { ok: true, data: { key: rotated.view, plaintext: rotated.plaintext, warning: '旧 Key 已立即失效；新 Key 之后仍可在列表中复制。' } })
    } catch {
      sendJson(res, 503, { ok: false, error: 'Key 存储写入失败，本次没有产生新 Key，旧 Key 仍然有效。', code: 'KEYS_STORE_UNAVAILABLE' })
    }
  }, { auth: 'admin' })

  // 复制（取回明文）
  router.post('/api-keys/:id/reveal', async (req, res, p) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    let result
    try {
      result = await store.reveal(p.id)
    } catch {
      return sendJson(res, 503, { ok: false, error: 'Key 存储读取失败', code: 'KEYS_STORE_UNAVAILABLE' })
    }
    if (result === null) return sendJson(res, 404, { ok: false, error: 'Key 不存在，或该 Key 已吊销、没有可复制的明文', code: 'KEY_NOT_FOUND' })
    sendJson(res, 200, { ok: true, data: { plaintext: result.plaintext } })
  }, { auth: 'admin' })

  // 吊销
  router.post('/api-keys/:id/revoke', async (req, res, p) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    try {
      const revoked = await store.revoke(p.id)
      if (!revoked) return sendJson(res, 404, { ok: false, error: 'Key 不存在，或该 Key 来自插件配置、不支持吊销', code: 'KEY_NOT_FOUND' })
      sendJson(res, 200, {
        ok: true,
        data: { id: revoked.id, status: revoked.status, revokedAt: revoked.revokedAt, message: `已吊销「${revoked.name || revoked.id}」。使用该 Key 的客户端从现在起会被拒绝。` },
      })
    } catch {
      sendJson(res, 503, { ok: false, error: 'Key 存储写入失败，「该 Key」仍然有效，请重试。', code: 'KEYS_STORE_UNAVAILABLE' })
    }
  }, { auth: 'admin' })

  // 删除（仅限已吊销）
  router.delete('/api-keys/:id', async (req, res, p) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    try {
      const removed = await store.remove(p.id)
      if (!removed) return sendJson(res, 404, { ok: false, error: 'Key 不存在，或该 Key 不是「已吊销」状态（仅已吊销的 Key 可删除）', code: 'KEY_NOT_FOUND' })
      sendJson(res, 200, { ok: true, data: { id: removed.id, message: `已删除「${removed.name || removed.id}」的记录。` } })
    } catch {
      sendJson(res, 503, { ok: false, error: 'Key 存储写入失败，删除没有生效，记录仍保留。', code: 'KEYS_STORE_UNAVAILABLE' })
    }
  }, { auth: 'admin' })

  // 鉴权状态
  router.get('/api-keys/auth', async (req, res) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    store.ensureReady()
    sendJson(res, 200, {
      ok: true,
      data: {
        authEnabled: store.getAuthEnabled(),
        authEnforcedByConfig: store.legacyEnforced,
        activeKeyCount: store.countActive(),
        legacyKeyPresent: store.legacyEnforced,
        adminRemoteAccess: guardOpts.adminRemoteAccess === true,
        storeDegraded: store.degraded,
        storeDegradedReason: store.degradedReason || undefined,
      },
    })
  }, { auth: 'admin' })

  // 鉴权开关
  router.put('/api-keys/auth', async (req, res, _p, _q, body) => {
    if (await rejectAdmin(req, res, store, guardOpts)) return
    const patch = body && typeof body === 'object' ? body : {}
    if (typeof patch.enabled !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: 'Invalid body: enabled 必须是 boolean', code: 'BAD_REQUEST' })
    }
    if (!patch.enabled) {
      if (store.legacyEnforced) {
        return sendJson(res, 400, { ok: false, error: '无法关闭鉴权：配置文件中的 apiKeys 强制开启了鉴权。请先从 config.json 移除 apiKeys，再回到本页面操作。', code: 'BAD_REQUEST' })
      }
      if (patch.confirm !== 'disable-auth') {
        return sendJson(res, 400, { ok: false, error: '关闭鉴权会让任何能访问本服务端口的程序无需 Key 即可调用全部接口。确认关闭请传 confirm: "disable-auth"。', code: 'BAD_REQUEST' })
      }
    }
    if (patch.enabled && store.countActive() === 0 && !store.legacyEnforced) {
      return sendJson(res, 400, { ok: false, error: '当前没有任何有效的 API Key，开启鉴权会拒绝所有 API 请求（把自己锁在外面）。请先生成一条 Key。', code: 'BAD_REQUEST' })
    }
    try {
      await store.setAuthEnabled(patch.enabled)
    } catch {
      return sendJson(res, 503, { ok: false, error: '设置保存失败，鉴权状态未改变。', code: 'KEYS_STORE_UNAVAILABLE' })
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        authEnabled: store.getAuthEnabled(),
        authEnforcedByConfig: store.legacyEnforced,
        activeKeyCount: store.countActive(),
        message: patch.enabled ? '鉴权已开启。客户端请求需携带有效 API Key。' : '鉴权已关闭。任何能访问本服务端口的程序都可调用全部接口，请尽快恢复。',
      },
    })
  }, { auth: 'admin' })
}
