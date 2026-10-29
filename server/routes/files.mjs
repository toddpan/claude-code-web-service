// routes/files.mjs — 会话工作区文件（对齐 dsh files.ts 路由与形状）
// ZCode 会话的工作区即 session.workspace.workspacePath，文件落盘语义与 dsh 一致：
// 会话中的 AI 可通过文件工具直接读取（把返回的 path 告诉它即可）。
import { mkdir, readdir, rename, rm, stat, writeFile, appendFile, readFile } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { sendJson } from '../http.mjs'
import { parseMultipart, sanitizeFilename, lookupMime } from '../util.mjs'

const STAGE_DIR = '.claude-uploads'

function uniqueTarget(dir, name) {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let candidate = path.join(dir, name)
  let i = 1
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`)
    i += 1
  }
  return candidate
}

function safeJoin(cwd, rel) {
  const root = path.resolve(cwd)
  const target = path.resolve(root, String(rel || '').replace(/^\//, ''))
  if (target !== root && !target.startsWith(root + path.sep)) return undefined
  return target
}

export function registerFileRoutes(router, engine, cfg) {
  const resolveCwd = id => engine.sessionCwd(id)

  // ---- 目录列表预览 ----
  router.get('/sessions/:id/files', async (_req, res, p, query) => {
    const cwd = await resolveCwd(p.id)
    if (!cwd) return sendJson(res, 404, { ok: false, error: `Session '${p.id}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
    const rel = String(query.path || '').trim()
    const target = safeJoin(cwd, rel)
    if (!target) return sendJson(res, 400, { ok: false, error: '非法路径：不允许越出会话工作区', code: 'BAD_REQUEST' })
    if (!existsSync(target)) return sendJson(res, 404, { ok: false, error: `目录不存在: ${rel || '.'}`, code: 'NOT_FOUND' })
    try {
      const st = await stat(target)
      if (!st.isDirectory()) return sendJson(res, 400, { ok: false, error: '该路径是文件，下载请用 /files/download', code: 'BAD_REQUEST' })
      const dirents = await readdir(target, { withFileTypes: true })
      const entries = []
      for (const d of dirents) {
        const full = path.join(target, d.name)
        let size = 0, mtime = 0
        try {
          const fst = await stat(full)
          size = fst.size
          mtime = Math.round(fst.mtimeMs)
        } catch { /* 保留 0 值 */ }
        const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file'
        const relPath = rel ? `${rel.replace(/\/+$/, '')}/${d.name}` : d.name
        entries.push({ name: d.name, type, size, mtime, path: relPath })
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id, cwd, path: rel || '.', count: entries.length, entries,
          hint: 'entry.path 为相对会话工作区的路径，可用于本接口 ?path= 逐层浏览或 /files/download 下载',
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `读取目录失败: ${err?.message || err}` })
    }
  })

  // ---- 下载 / 内联预览 ----
  router.get('/sessions/:id/files/download', async (_req, res, p, query) => {
    const cwd = await resolveCwd(p.id)
    if (!cwd) return sendJson(res, 404, { ok: false, error: `Session '${p.id}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
    const rel = String(query.path || query.name || '').trim()
    if (!rel) return sendJson(res, 400, { ok: false, error: '缺少 ?path=（相对会话工作区的文件路径）', code: 'BAD_REQUEST' })
    const target = safeJoin(cwd, rel)
    if (!target) return sendJson(res, 400, { ok: false, error: '非法路径：不允许越出会话工作区', code: 'BAD_REQUEST' })
    if (!existsSync(target)) return sendJson(res, 404, { ok: false, error: `文件不存在: ${rel}`, code: 'NOT_FOUND' })
    try {
      const st = await stat(target)
      if (st.isDirectory()) return sendJson(res, 400, { ok: false, error: '该路径是目录，请用 GET /sessions/:id/files 列表接口', code: 'BAD_REQUEST' })
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
      sendJson(res, 500, { ok: false, error: `读取文件失败: ${err?.message || err}` })
    }
  })

  // ---- 上传（multipart 或原始流） ----
  router.post('/sessions/:id/files', async (req, res, p, query, body) => {
    const contentType = String(req.headers['content-type'] || '')
    const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
    const maxBytes = cfg.maxUploadBytes || 2 * 1024 * 1024 * 1024
    if (buffer.length === 0) return sendJson(res, 400, { ok: false, error: '请求体为空：请以 multipart/form-data 或原始字节流上传文件', code: 'BAD_REQUEST' })
    if (buffer.length > maxBytes) return sendJson(res, 413, { ok: false, error: `Payload too large (> ${maxBytes} bytes)`, code: 'PAYLOAD_TOO_LARGE' })

    let files = []
    if (/^multipart\/form-data/i.test(contentType)) {
      const parts = parseMultipart(buffer, contentType)
      files = parts.filter(x => x.filename !== undefined && x.filename !== '' && x.data.length > 0)
        .map(x => ({ filename: sanitizeFilename(x.filename), mimeType: x.mimeType, data: x.data }))
      if (files.length === 0) return sendJson(res, 400, { ok: false, error: 'multipart 请求中未找到带 filename 的文件字段', code: 'BAD_REQUEST' })
    } else {
      const rawName = (query.filename || (req.headers['x-filename'] || '')).trim()
      files = [{ filename: sanitizeFilename(rawName || `upload-${Date.now()}`), mimeType: contentType || undefined, data: buffer }]
    }

    const cwd = await resolveCwd(p.id)
    if (!cwd) return sendJson(res, 404, { ok: false, error: `Session '${p.id}' not found or has no workspace cwd`, code: 'NOT_FOUND' })

    try {
      await mkdir(cwd, { recursive: true })
      const saved = []
      for (const f of files) {
        const target = uniqueTarget(cwd, f.filename)
        await writeFile(target, f.data)
        saved.push({ name: path.basename(target), path: target, size: f.data.length, mimeType: f.mimeType })
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id, cwd, count: saved.length,
          totalBytes: saved.reduce((acc, f) => acc + f.size, 0),
          files: saved,
          hint: '文件已写入会话工作区，会话中的 AI 可通过文件工具直接读取（把返回的 path 告诉它即可）',
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `写入文件失败: ${err?.message || err}` })
    }
  }, { rawBody: true })

  // ---- 分片断点续传 ----
  const stageDirOf = cwd => path.join(cwd, STAGE_DIR)
  const stagePathsOf = (cwd, uploadId) => {
    const id = String(uploadId || '').replace(/[^A-Za-z0-9._-]/g, '')
    if (!id || id.length > 120) return undefined
    return { part: path.join(stageDirOf(cwd), id + '.part'), meta: path.join(stageDirOf(cwd), id + '.json') }
  }
  const readStageMeta = async metaFile => {
    try {
      const obj = JSON.parse(await readFile(metaFile, 'utf-8'))
      if (obj && typeof obj.name === 'string') return obj
    } catch { /* 无 meta */ }
    return undefined
  }
  const stageReceived = async partFile => {
    try { return (await stat(partFile)).size } catch { return 0 }
  }

  router.post('/sessions/:id/files/resumable', async (_req, res, p, query) => {
    const cwd = await resolveCwd(p.id)
    if (!cwd) return sendJson(res, 404, { ok: false, error: `Session '${p.id}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
    const name = sanitizeFilename(query.name)
    const size = Math.max(0, Math.floor(Number(query.size) || 0))
    const mimeType = String(query.mimeType || '').slice(0, 120) || undefined
    const uploadId = `up-${randomUUID().replace(/-/g, '').slice(0, 20)}`
    try {
      await mkdir(stageDirOf(cwd), { recursive: true })
      const paths = stagePathsOf(cwd, uploadId)
      await writeFile(paths.part, Buffer.alloc(0))
      await writeFile(paths.meta, JSON.stringify({ name, size, mimeType, createdAt: Date.now() }))
      sendJson(res, 200, { ok: true, data: { uploadId, name, size, received: 0 } })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `初始化分片上传失败: ${err?.message || err}` })
    }
  }, { rawBody: true })

  router.get('/sessions/:id/files/resumable/:uploadId', async (_req, res, p) => {
    const cwd = await resolveCwd(p.id)
    const paths = cwd ? stagePathsOf(cwd, p.uploadId) : undefined
    if (!cwd || !paths) return sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
    const meta = await readStageMeta(paths.meta)
    if (!meta) return sendJson(res, 404, { ok: false, error: '上传会话不存在或已完成/清理', code: 'NOT_FOUND' })
    sendJson(res, 200, { ok: true, data: { uploadId: p.uploadId, name: meta.name, size: meta.size, received: await stageReceived(paths.part) } })
  })

  router.add('PUT', '/sessions/:id/files/resumable/:uploadId', async (_req, res, p, query, body) => {
    const cwd = await resolveCwd(p.id)
    const paths = cwd ? stagePathsOf(cwd, p.uploadId) : undefined
    if (!cwd || !paths) return sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
    const meta = await readStageMeta(paths.meta)
    if (!meta) return sendJson(res, 404, { ok: false, error: '上传会话不存在或已完成/清理', code: 'NOT_FOUND' })
    const chunk = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
    if (chunk.length === 0) return sendJson(res, 400, { ok: false, error: '分片内容为空', code: 'BAD_REQUEST' })
    const received = await stageReceived(paths.part)
    const offset = Number(query.offset)
    if (!Number.isFinite(offset) || offset < 0 || offset !== received) {
      return sendJson(res, 409, { ok: false, error: `offset 不匹配：服务端已接收 ${received} 字节`, code: 'OFFSET_MISMATCH', data: { received } })
    }
    try {
      await appendFile(paths.part, chunk)
      sendJson(res, 200, { ok: true, data: { uploadId: p.uploadId, received: received + chunk.length } })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `写入分片失败: ${err?.message || err}` })
    }
  }, { rawBody: true })

  router.post('/sessions/:id/files/resumable/:uploadId/complete', async (_req, res, p) => {
    const cwd = await resolveCwd(p.id)
    const paths = cwd ? stagePathsOf(cwd, p.uploadId) : undefined
    if (!cwd || !paths) return sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
    const meta = await readStageMeta(paths.meta)
    if (!meta) return sendJson(res, 404, { ok: false, error: '上传会话不存在或已完成/清理', code: 'NOT_FOUND' })
    const received = await stageReceived(paths.part)
    if (meta.size > 0 && received !== meta.size) {
      return sendJson(res, 409, { ok: false, error: `文件未传完：已接收 ${received}/${meta.size} 字节`, code: 'INCOMPLETE', data: { received, size: meta.size } })
    }
    try {
      const target = uniqueTarget(cwd, meta.name)
      await rename(paths.part, target)
      await rm(paths.meta, { force: true })
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: p.id, cwd, count: 1,
          files: [{ name: path.basename(target), path: target, size: received, mimeType: meta.mimeType }],
          hint: '文件已写入会话工作区，会话中的 AI 可通过文件工具直接读取（把返回的 path 告诉它即可）',
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `落盘失败: ${err?.message || err}` })
    }
  })

  router.delete('/sessions/:id/files/resumable/:uploadId', async (_req, res, p) => {
    const cwd = await resolveCwd(p.id)
    const paths = cwd ? stagePathsOf(cwd, p.uploadId) : undefined
    if (!cwd || !paths) return sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
    await rm(paths.part, { force: true })
    await rm(paths.meta, { force: true })
    sendJson(res, 200, { ok: true, data: { uploadId: p.uploadId, aborted: true } })
  })
}
