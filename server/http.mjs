// http.mjs — HTTP 路由器：:param 路径、public/data/admin 三档鉴权、原始体上传、
// 统一响应信封 {ok, data?, error?, code?, timestamp}（对齐 dsh-web-service）。

import { timingSafeEqual } from 'node:crypto'

export function sendJson(res, statusCode, payload) {
  if (res.headersSent) return
  payload.timestamp = Date.now()
  const data = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(data))
  res.end(data)
}

export function initSseStream(res) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  return {
    send(event, data) {
      if (res.writableEnded) return
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      res.write(`event: ${event}\ndata: ${text}\n\n`)
    },
    close() {
      if (!res.writableEnded) res.end()
    },
  }
}

export function readJsonBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', c => {
      total += c.length
      if (total > maxBytes) { req.destroy(); reject(Object.assign(new Error(`Payload too large (> ${maxBytes} bytes)`), { tooLarge: true })); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`Failed to parse JSON: ${e.message}`)) }
    })
    req.on('error', reject)
  })
}

export function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', c => {
      total += c.length
      if (total > maxBytes) { req.destroy(); reject(Object.assign(new Error(`Payload too large (> ${maxBytes} bytes)`), { tooLarge: true })); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 数据面鉴权服务接口（keys-store 提供） */
export class HttpRouter {
  constructor(config) {
    this.routes = []
    this.config = config
    this.auth = null
    /** 非回环访问闸门（zcode-web-service 安全默认；(req)=>boolean） */
    this.remoteGate = null
  }

  setAuthService(auth) { this.auth = auth }
  setRemoteGate(fn) { this.remoteGate = fn }

  add(method, pathPattern, handler, options = {}) {
    const paramNames = []
    const regexStr = pathPattern
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)' })
      .replace(/\//g, '\\/')
    this.routes.push({ method: method.toUpperCase(), pattern: new RegExp(`^${regexStr}$`), paramNames, handler, rawBody: options.rawBody, auth: options.auth })
  }

  get(p, h, o) { this.add('GET', p, h, o) }
  post(p, h, o) { this.add('POST', p, h, o) }
  put(p, h, o) { this.add('PUT', p, h, o) }
  patch(p, h, o) { this.add('PATCH', p, h, o) }
  delete(p, h, o) { this.add('DELETE', p, h, o) }

  async dispatch(req, res, basePath = '') {
    const url = req.url || '/'
    let pathname, searchParams
    try {
      const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`)
      pathname = parsed.pathname
      searchParams = parsed.searchParams
    } catch {
      pathname = url.split('?')[0] || '/'
      searchParams = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?')) : '')
    }

    this.setCorsHeaders(req, res)
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true }

    let targetPath = pathname
    if (basePath && targetPath.startsWith(basePath)) {
      targetPath = targetPath.slice(basePath.length)
      if (!targetPath.startsWith('/')) targetPath = '/' + targetPath
    }

    const reqMethod = (req.method || 'GET').toUpperCase()
    let matched = null
    const params = {}
    for (const route of this.routes) {
      if (route.method !== reqMethod && route.method !== 'ALL') continue
      const m = targetPath.match(route.pattern)
      if (m) {
        matched = route
        route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1] || '') })
        break
      }
    }
    if (!matched) return false

    const query = {}
    for (const [k, v] of searchParams.entries()) query[k] = v

    // 鉴权：public 恒开放；data 走 API Key（多 Key ∪ 遗留 config.apiKeys）；admin 路由自行管理
    const authMode = matched.auth || 'data'
    const isPublic = authMode === 'public' || targetPath === '/docs' || targetPath === '/openapi.json' || targetPath === '/'
    if (authMode !== 'admin' && !isPublic && this.remoteGate?.(req)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden: remote access disabled; set allowRemote:true in config', code: 'FORBIDDEN_REMOTE' })
      return true
    }
    if (authMode === 'data' && !isPublic) {
      const enforced = this.auth ? this.auth.isEnforced() : false
      if (enforced) {
        const authHeader = req.headers['authorization'] || ''
        const xApiKey = req.headers['x-api-key']
        let token = ''
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim()
        else if (typeof xApiKey === 'string') token = xApiKey.trim()
        const verdict = this.auth
          ? this.auth.verifyDataToken(token)
          : { ok: false }
        if (!verdict.ok) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized: Invalid or missing API key', code: 'UNAUTHORIZED' })
          return true
        }
        if (verdict.keyId && this.auth) this.auth.touch(verdict.keyId)
      }
    }

    let body = null
    if (['POST', 'PUT', 'PATCH'].includes(reqMethod)) {
      try {
        body = matched.rawBody
          ? await readRawBody(req, this.config.maxUploadBytes || 2 * 1024 * 1024 * 1024)
          : await readJsonBody(req)
      } catch (err) {
        sendJson(res, err?.tooLarge ? 413 : 400, {
          ok: false,
          error: err?.message || 'Failed to read request body',
          code: err?.tooLarge ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        })
        return true
      }
    }

    try {
      await matched.handler(req, res, params, query, body)
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err?.message || 'Internal Server Error', code: 'INTERNAL_ERROR' })
      }
    }
    return true
  }

  setCorsHeaders(req, res) {
    res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Token, Accept')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
}

/** 常量时间比较（未注入鉴权服务时兜底） */
export function timingSafeEqualString(a, b) {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
