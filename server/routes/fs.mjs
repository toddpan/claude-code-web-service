// routes/fs.mjs — 远端文件系统浏览与管理（对齐 dsh fs.ts 路由与形状）
import { opendir, stat, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { sendJson } from '../http.mjs'
import { parseMultipart, sanitizeFilename, lookupMime } from '../util.mjs'

const MAX_ENTRIES = 2000

function sendErr(res, status, code, message) {
  sendJson(res, status, { ok: false, error: message, code })
}

async function listFsEntries(target, includeFiles) {
  const rows = []
  let truncated = false
  const dir = await opendir(target)
  try {
    for await (const dirent of dir) {
      const isDir = dirent.isDirectory()
      const isLink = dirent.isSymbolicLink()
      let enterable = isDir
      let targetType = isDir ? 'dir' : isLink ? 'link' : 'file'
      let size = 0
      let mtime = 0
      const fullPath = path.join(target, dirent.name)
      if (isLink) {
        try {
          const st = statSync(fullPath)
          enterable = st.isDirectory()
          targetType = enterable ? 'dir' : 'file'
          size = st.size
          mtime = Math.round(st.mtimeMs)
        } catch {
          if (!includeFiles) continue
        }
      } else {
        try {
          const st = await stat(fullPath)
          size = st.size
          mtime = Math.round(st.mtimeMs)
        } catch { /* 读取元数据失败 */ }
      }
      if (!includeFiles && !enterable) continue
      if (rows.length >= MAX_ENTRIES) { truncated = true; break }
      rows.push({
        name: dirent.name,
        path: fullPath,
        type: targetType,
        size: targetType === 'dir' ? undefined : size,
        mtime: mtime || undefined,
        hidden: dirent.name.startsWith('.'),
      })
    }
  } finally {
    void dir.close().catch(() => {})
  }
  rows.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
  return { entries: rows, truncated }
}

export function registerFsRoutes(router, cfg) {
  router.get('/fs/list', async (_req, res, _p, query) => {
    const raw = String(query.path || '').trim()
    const includeFiles = query.all === '1' || query.all === 'true' || query.files === '1'
    const home = homedir()
    let target
    if (!raw) target = path.resolve(home)
    else {
      if (!path.isAbsolute(raw)) return sendErr(res, 400, 'BAD_REQUEST', `cannot list "${raw}": not a fully qualified path`)
      target = path.resolve(raw)
    }
    try {
      if (!existsSync(target)) return sendErr(res, 400, 'DIRECTORY_UNREADABLE', `cannot list "${target}": 目录不存在`)
      const st = statSync(target)
      if (!st.isDirectory()) return sendErr(res, 400, 'DIRECTORY_UNREADABLE', `cannot list "${target}": 不是目录`)
      const { entries, truncated } = await listFsEntries(target, includeFiles)
      const parent = target === path.parse(target).root ? undefined : path.dirname(target)
      sendJson(res, 200, { ok: true, data: { path: target, home, parent, entries, truncated, maxEntries: MAX_ENTRIES } })
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') return sendErr(res, 400, 'DIRECTORY_UNREADABLE', `cannot list "${target}": 权限不足`)
      sendErr(res, 500, 'LIST_FAILED', err?.message || String(err))
    }
  })

  router.get('/fs/download', async (_req, res, _p, query) => {
    const raw = String(query.path || '').trim()
    if (!raw || !path.isAbsolute(raw)) return sendErr(res, 400, 'BAD_REQUEST', 'path 必须是绝对路径')
    const target = path.resolve(raw)
    if (!existsSync(target)) return sendErr(res, 404, 'NOT_FOUND', `文件不存在: ${target}`)
    try {
      const st = statSync(target)
      if (st.isDirectory()) return sendErr(res, 400, 'BAD_REQUEST', '该路径是目录，请使用 /fs/list 浏览')
      const name = path.basename(target)
      const inline = query.inline === '1' || query.inline === 'true'
      res.statusCode = 200
      res.setHeader('Content-Type', lookupMime(target))
      res.setHeader('Content-Length', String(st.size))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_') || 'download'
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      const stream = createReadStream(target)
      stream.on('error', err => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: `读取文件失败: ${err?.message || err}` })
        else res.destroy()
      })
      stream.pipe(res)
    } catch (err) {
      sendErr(res, 500, 'DOWNLOAD_FAILED', err?.message || String(err))
    }
  })

  router.post('/fs/mkdir', async (_req, res, _p, _q, body) => {
    const parent = String(body?.path || '').trim()
    const name = String(body?.name || '').trim()
    if (!parent || !path.isAbsolute(parent)) return sendErr(res, 400, 'BAD_REQUEST', 'path 必须是绝对路径')
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return sendErr(res, 400, 'BAD_REQUEST', 'name 不合法（不能为空、不含路径分隔符、不能是 . 或 ..）')
    }
    const target = path.join(path.resolve(parent), name)
    try {
      if (!existsSync(parent)) return sendErr(res, 400, 'DIRECTORY_UNREADABLE', `父目录不存在: ${parent}`)
      if (existsSync(target)) return sendErr(res, 409, 'ALREADY_EXISTS', `同名条目已存在: ${target}`)
      await mkdir(target, { recursive: true })
      sendJson(res, 200, { ok: true, data: { path: target, name } })
    } catch (err) {
      sendErr(res, 500, 'MKDIR_FAILED', err?.message || String(err))
    }
  })

  router.delete('/fs/remove', async (_req, res, _p, query) => {
    const raw = String(query.path || '').trim()
    if (!raw || !path.isAbsolute(raw)) return sendErr(res, 400, 'BAD_REQUEST', 'path 必须是绝对路径')
    const target = path.resolve(raw)
    const home = homedir()
    if (target === '/' || target === home) return sendErr(res, 403, 'FORBIDDEN', '禁止删除根目录或用户主目录根')
    if (!existsSync(target)) return sendErr(res, 404, 'NOT_FOUND', `目标不存在: ${target}`)
    try {
      await rm(target, { recursive: true, force: true })
      sendJson(res, 200, { ok: true, data: { path: target, removed: true } })
    } catch (err) {
      sendErr(res, 500, 'REMOVE_FAILED', err?.message || String(err))
    }
  })

  router.post('/fs/upload', async (req, res, _p, query, body) => {
    const destDir = String(query.path || '').trim()
    if (!destDir || !path.isAbsolute(destDir)) return sendErr(res, 400, 'BAD_REQUEST', 'path 必须是目标目录绝对路径')
    const targetDir = path.resolve(destDir)
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      return sendErr(res, 400, 'DIRECTORY_UNREADABLE', `目标目录不存在: ${targetDir}`)
    }
    const contentType = String(req.headers['content-type'] || '')
    const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
    const maxBytes = cfg.maxUploadBytes || 2 * 1024 * 1024 * 1024
    if (buffer.length === 0) return sendErr(res, 400, 'BAD_REQUEST', '请求体为空')
    if (buffer.length > maxBytes) return sendErr(res, 413, 'PAYLOAD_TOO_LARGE', `Payload too large (> ${maxBytes} bytes)`)

    let files = []
    if (/^multipart\/form-data/i.test(contentType)) {
      const parts = parseMultipart(buffer, contentType)
      files = parts.filter(p => p.filename !== undefined && p.filename !== '' && p.data.length > 0)
        .map(p => ({ filename: sanitizeFilename(p.filename), mimeType: p.mimeType, data: p.data }))
      if (files.length === 0) return sendErr(res, 400, 'BAD_REQUEST', 'multipart 请求中未找到文件')
    } else {
      const rawName = (query.filename || (req.headers['x-filename'] || '')).trim()
      files = [{ filename: sanitizeFilename(rawName || `upload-${Date.now()}`), mimeType: contentType || undefined, data: buffer }]
    }

    try {
      const saved = []
      for (const f of files) {
        const candidate = uniqueTargetSync(targetDir, f.filename)
        await writeFile(candidate, f.data)
        saved.push({ name: path.basename(candidate), path: candidate, size: f.data.length, mimeType: f.mimeType })
      }
      sendJson(res, 200, { ok: true, data: { count: saved.length, files: saved } })
    } catch (err) {
      sendErr(res, 500, 'UPLOAD_FAILED', err?.message || String(err))
    }
  }, { rawBody: true })
}

function uniqueTargetSync(dir, name) {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let candidate = path.join(dir, name)
  let i = 1
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`)
    i++
  }
  return candidate
}
