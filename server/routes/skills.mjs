// routes/skills.mjs — 技能全生命周期管理（对齐 dsh skills.ts 路由与形状）
// ZCode 技能根：user=~/.zcode/skills（默认），agents=~/.agents/skills，project（需 cwd），custom（服务配置）。
import { mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sendJson } from '../http.mjs'
import {
  discoverSkills, extractTar, extractZip, isSkillName, parseSkillFile,
  parseYamlSubset, resolveSkillRoot, serializeFrontmatter, parseMultipart,
} from '../util.mjs'

const execFileAsync = promisify(execFile)

export function registerSkillRoutes(router, cfg) {
  const maxBytes = cfg.maxUploadBytes || 2 * 1024 * 1024 * 1024
  const customDirs = cfg.customSkillDirs || []
  const rootOf = (kind, cwd) => {
    const resolved = resolveSkillRoot(kind, cwd, customDirs)
    if (!resolved.ok) return { error: resolved.error }
    return { root: resolved.root }
  }

  router.get('/skills', async (_req, res, _p, query) => {
    const r = rootOf(query.root, query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    try {
      const skills = await discoverSkills(r.root.path)
      const kw = (query.search || '').trim().toLowerCase()
      const filtered = kw ? skills.filter(s => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)) : skills
      return sendJson(res, 200, { ok: true, data: { root: { kind: r.root.kind, path: r.root.path }, count: filtered.length, skills: filtered } })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `读取技能失败: ${err?.message || err}` })
    }
  })

  router.get('/skills/:name', async (_req, res, p, query) => {
    const r = rootOf(query.root, query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    const name = p.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const skillPath = skillPathFor(name, r.root.path)
    if (!existsSync(skillPath)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      const raw = await readFile(skillPath, 'utf-8')
      const parsed = parseSkillFile(raw)
      if (!parsed) return sendJson(res, 400, { ok: false, error: `技能文件 ${skillPath} 解析失败`, code: 'BAD_REQUEST' })
      return sendJson(res, 200, {
        ok: true,
        data: {
          name, path: skillPath, root: r.root.path,
          description: parsed.description, whenToUse: parsed.whenToUse,
          modelInvocable: parsed.frontmatter.modelInvocable, userInvocable: parsed.frontmatter.userInvocable,
          content: parsed.body, raw, size: raw.length,
        },
      })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `读取技能失败: ${err?.message || err}` })
    }
  })

  router.get('/skills/:name/body', async (_req, res, p, query) => {
    const r = rootOf(query.root, query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    const name = p.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const skillPath = skillPathFor(name, r.root.path)
    if (!existsSync(skillPath)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      const raw = await readFile(skillPath, 'utf-8')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Length', String(Buffer.byteLength(raw)))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`)
      res.end(raw)
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `读取技能失败: ${err?.message || err}` })
    }
  })

  router.get('/skills/:name/archive', async (_req, res, p, query) => {
    const r = rootOf(query.root, query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    const name = p.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const dir = path.join(r.root.path, name)
    const flat = path.join(r.root.path, `${name}.md`)
    const targetDir = existsSync(dir) ? dir : undefined
    if (!targetDir && !existsSync(flat)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    const archName = `${name}.tgz`
    const tmpFile = path.join(tmpdir(), `zws-skill-${name}-${Date.now()}.tgz`)
    try {
      await execFileAsync('tar', [
        'czf', tmpFile, '-C', targetDir ? path.dirname(targetDir) : r.root.path,
        '--exclude=__pycache__', '--exclude=node_modules',
        targetDir ? name : `${name}.md`,
      ], { timeout: 60_000 })
      const st = await stat(tmpFile)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Length', String(st.size))
      res.setHeader('Content-Disposition', `attachment; filename="${archName}"`)
      const readStream = createReadStream(tmpFile)
      readStream.on('error', () => { res.destroy() })
      readStream.on('end', () => { void rm(tmpFile, { force: true }).catch(() => {}) })
      readStream.pipe(res)
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `归档失败: ${err?.message || err}` })
    }
  })

  router.post('/skills', async (req, res, _p, query, body) => {
    const contentType = String(req.headers['content-type'] || '')
    const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
    if (buffer.length === 0) return sendJson(res, 400, { ok: false, error: '请求体为空：请以 multipart/压缩包或 JSON 上传技能', code: 'BAD_REQUEST' })
    if (buffer.length > maxBytes) return sendJson(res, 413, { ok: false, error: `Payload too large (> ${maxBytes} bytes)`, code: 'PAYLOAD_TOO_LARGE' })

    if (/^multipart\/form-data/i.test(contentType)) {
      const parts = parseMultipart(buffer, contentType)
      const fields = {}
      let file
      for (const x of parts) {
        if (x.filename !== undefined && x.data.length > 0) file = x
        else if (x.name !== undefined) fields[x.name] = x.data.toString('utf-8')
      }
      if (!file) return sendJson(res, 400, { ok: false, error: 'multipart 中未找到技能压缩包文件字段', code: 'BAD_REQUEST' })
      const r = rootOf(fields.root || query.root, fields.cwd || query.cwd)
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
      const name = (fields.name || '').trim() || undefined
      try {
        const result = await installSkillArchive(r.root.path, file.data, file.filename, name)
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error, code: 'BAD_REQUEST' })
        return sendJson(res, 200, { ok: true, data: result })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `解压落盘失败: ${err?.message || err}` })
      }
    }

    let json
    try {
      json = JSON.parse(buffer.toString('utf-8'))
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: `JSON 解析失败: ${err?.message || err}`, code: 'BAD_REQUEST' })
    }
    const r = rootOf(json.root || query.root, json.cwd || query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    const name = String(json.name || '').trim()
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name || '(空)'}`, code: 'BAD_REQUEST' })
    const description = String(json.description || '').trim()
    if (!description) return sendJson(res, 400, { ok: false, error: 'description 不能为空', code: 'BAD_REQUEST' })
    try {
      const result = await createSkillFromJson(r.root.path, json)
      return sendJson(res, 200, { ok: true, data: result })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `写入技能失败: ${err?.message || err}` })
    }
  }, { rawBody: true })

  router.put('/skills/:name', async (_req, res, p, query, body) => {
    const r = rootOf(query.root, query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    const name = p.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const skillPath = skillPathFor(name, r.root.path)
    if (!existsSync(skillPath)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      const existing = await readFile(skillPath, 'utf-8')
      const parsed = parseSkillFile(existing) || { frontmatter: parseYamlSubset(''), body: existing }
      const fm = parsed.frontmatter
      if (body?.description !== undefined) fm.description = String(body.description).trim()
      if (body?.whenToUse !== undefined) fm.whenToUse = String(body.whenToUse).trim()
      if (typeof body?.modelInvocable === 'boolean') {
        fm['disable-model-invocation'] = !body.modelInvocable
        fm.modelInvocable = body.modelInvocable
      }
      if (typeof body?.userInvocable === 'boolean') {
        fm['user-invocable'] = body.userInvocable
        fm.userInvocable = body.userInvocable
      }
      const content = body?.content !== undefined ? String(body.content).trim() : undefined
      const frontmatterStr = serializeFrontmatter(fm)
      const newRaw = `${frontmatterStr}\n\n${content ?? parsed.body}\n`
      await writeFile(skillPath, newRaw, 'utf-8')
      return sendJson(res, 200, { ok: true, data: { name, path: skillPath, size: Buffer.byteLength(newRaw) } })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `更新技能失败: ${err?.message || err}` })
    }
  })

  router.delete('/skills/:name', async (_req, res, p, query) => {
    const r = rootOf(query.root, query.cwd)
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, code: 'BAD_REQUEST' })
    const name = p.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const dir = path.join(r.root.path, name)
    const flat = path.join(r.root.path, `${name}.md`)
    const target = existsSync(dir) ? dir : existsSync(flat) ? flat : undefined
    if (!target) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      await rm(target, { recursive: true, force: true })
      return sendJson(res, 200, { ok: true, data: { name, deleted: true } })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `删除技能失败: ${err?.message || err}` })
    }
  })
}

function skillPathFor(name, rootPath) {
  const dir = path.join(rootPath, name)
  if (existsSync(path.join(dir, 'SKILL.md'))) return path.join(dir, 'SKILL.md')
  const flat = path.join(rootPath, `${name}.md`)
  return existsSync(flat) ? flat : path.join(dir, 'SKILL.md')
}

async function installSkillArchive(rootPath, data, filename, explicitName) {
  await mkdir(rootPath, { recursive: true })
  const fname = (filename || '').toLowerCase()
  const tmpDir = path.join(tmpdir(), `zws-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const extractResult = fname.endsWith('.zip') ? await extractZip(data, tmpDir) : await extractTar(data, tmpDir, 0)
  if (!extractResult.ok) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: extractResult.error }
  }
  try {
    const located = await locateSkillInTree(tmpDir)
    if (!located) {
      const topDirs = (await readdir(tmpDir, { withFileTypes: true })).filter(d => d.isDirectory())
      if (topDirs.length === 1) {
        const inner = await locateSkillInTree(path.join(tmpDir, topDirs[0].name))
        if (inner) return finalizeSkill(inner, tmpDir, rootPath, explicitName)
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: '压缩包内未找到有效的 SKILL.md' }
    }
    return finalizeSkill(located, tmpDir, rootPath, explicitName)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: err?.message || err }
  }
}

async function locateSkillInTree(dir) {
  const direct = path.join(dir, 'SKILL.md')
  if (existsSync(direct)) {
    const parsed = parseSkillFile(await readFile(direct, 'utf-8'))
    return { dir, skillPath: direct, name: parsed?.name, flat: false }
  }
  const sub = (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory())
  if (sub.length === 1) {
    const innerSkill = path.join(dir, sub[0].name, 'SKILL.md')
    if (existsSync(innerSkill)) {
      const parsed = parseSkillFile(await readFile(innerSkill, 'utf-8'))
      return { dir: path.join(dir, sub[0].name), skillPath: innerSkill, name: parsed?.name, flat: false }
    }
  }
  for (const f of (await readdir(dir)).filter(x => x.endsWith('.md'))) {
    const x = path.join(dir, f)
    const parsed = parseSkillFile(await readFile(x, 'utf-8'))
    if (parsed) return { dir, skillPath: x, name: parsed.name, flat: true }
  }
  return undefined
}

async function finalizeSkill(located, tmpDir, rootPath, explicitName) {
  const parsed = parseSkillFile(await readFile(located.skillPath, 'utf-8'))
  const defaultName = parsed?.name || (!located.flat ? path.basename(located.dir) : undefined)
  const name = explicitName || defaultName
  if (!name || !isSkillName(name)) return { ok: false, error: `无法确定技能名: ${name || '(空)'}` }
  const targetDir = path.join(rootPath, name)
  await rm(targetDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(targetDir, { recursive: true })
  if (located.flat) {
    await writeFile(path.join(targetDir, 'SKILL.md'), await readFile(located.skillPath))
  } else {
    await copyDirContents(located.dir, targetDir)
  }
  const finalSkill = path.join(targetDir, 'SKILL.md')
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  if (!existsSync(finalSkill)) return { ok: false, error: '技能目录缺少 SKILL.md' }
  return { ok: true, name, path: finalSkill }
}

async function copyDirContents(srcDir, dstDir) {
  for (const it of await readdir(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, it.name)
    const d = path.join(dstDir, it.name)
    if (it.isDirectory()) await copyDir(s, d)
    else if (it.isFile()) await writeFile(d, await readFile(s))
  }
}

async function copyDir(src, dst) {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dst, { recursive: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else if (e.isFile()) await writeFile(d, await readFile(s))
  }
}

async function createSkillFromJson(rootPath, json) {
  const name = String(json.name).trim()
  const targetDir = path.join(rootPath, name)
  await mkdir(targetDir, { recursive: true })
  const fm = {
    name,
    description: String(json.description).trim(),
    ...(json.whenToUse ? { whenToUse: String(json.whenToUse).trim() } : {}),
    ...(typeof json.modelInvocable === 'boolean' ? { 'disable-model-invocation': !json.modelInvocable } : {}),
    ...(typeof json.userInvocable === 'boolean' ? { 'user-invocable': json.userInvocable } : {}),
  }
  const raw = `${serializeFrontmatter(fm)}\n\n${String(json.content || '').trim()}\n`
  const skillPath = path.join(targetDir, 'SKILL.md')
  await writeFile(skillPath, raw, 'utf-8')
  return { name, path: skillPath, size: Buffer.byteLength(raw) }
}
