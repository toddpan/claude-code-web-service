// util.mjs — 共享工具：MIME、multipart、文件名/路径安全、frontmatter(YAML 子集)、技能发现与解压。
// 移植自 dsh-web-service（files.ts / skill-utils.ts），零依赖。

import { mkdir, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

// ---------------- MIME ----------------

export const MIME_MAP = {
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8', '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.bash': 'text/plain; charset=utf-8', '.zsh': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8', '.java': 'text/plain; charset=utf-8', '.c': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8', '.h': 'text/plain; charset=utf-8', '.hpp': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

export function lookupMime(filePath) {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

// ---------------- multipart / 上传 ----------------

export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return []
  const boundary = '--' + (m[1] || m[2]).trim()
  const delim = Buffer.from(boundary)
  const parts = []
  let pos = buffer.indexOf(delim)
  while (pos >= 0) {
    const start = pos + delim.length
    if (buffer.slice(start, start + 2).toString('utf-8') === '--') break
    const headStart = start + 2
    const headEnd = buffer.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) break
    const headerBlock = buffer.slice(headStart, headEnd).toString('utf-8')
    const bodyStart = headEnd + 4
    const next = buffer.indexOf(delim, bodyStart)
    if (next < 0) break
    let bodyEnd = next
    if (buffer.slice(bodyEnd - 2, bodyEnd).toString('utf-8') === '\r\n') bodyEnd -= 2
    parts.push(parsePartHeaders(headerBlock, buffer.slice(bodyStart, bodyEnd)))
    pos = next
  }
  return parts
}

function parsePartHeaders(headerBlock, data) {
  let name, filename, mimeType
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (/^content-disposition$/i.test(key)) {
      name = /(?:^|;\s*)name="([^"]*)"/i.exec(value)?.[1] ?? name
      const fnStar = /filename\*=([^;\r\n]+)/i.exec(value)?.[1]
      if (fnStar) {
        const decoded = /^([^']*)''(.*)$/.exec(fnStar.trim())
        filename = decodeFilename(decoded ? decoded[2] : fnStar.trim())
      }
      if (!filename) {
        const fn = /filename="([^"]*)"/i.exec(value)?.[1] ?? /filename=([^;\r\n]+)/i.exec(value)?.[1]
        if (fn !== undefined) filename = decodeFilename(fn)
      }
    } else if (/^content-type$/i.test(key)) {
      mimeType = value
    }
  }
  return { name, filename, mimeType, data }
}

function decodeFilename(raw) {
  const v = raw.trim().replace(/^"|"$/g, '')
  try { return decodeURIComponent(v) } catch { return v }
}

export function sanitizeFilename(raw) {
  let name = String(raw || '').split(/[\\/]/).pop() || ''
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name || name === '.' || name === '..') name = `file-${Date.now()}`
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 16)
    name = name.slice(0, 180 - ext.length) + ext
  }
  return name
}

/** 目标路径去重：同名自动 -1/-2 后缀，永不覆盖 */
export function uniqueTarget(dir, name) {
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

/** 相对路径安全拼接：解析后必须仍位于 root 内（防 ../ 越界） */
export function safeJoin(root, rel) {
  const r = path.resolve(root)
  const target = path.resolve(r, String(rel || '').replace(/^\//, ''))
  if (target !== r && !target.startsWith(r + path.sep)) return undefined
  return target
}

// ---------------- frontmatter / 技能 ----------------

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function isSkillName(name) { return SKILL_NAME_RE.test(name) }

export function parseYamlSubset(text) {
  const result = { modelInvocable: true, userInvocable: true }
  const lines = text.split(/\r?\n/)
  let lastKey
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (m) {
      lastKey = m[1]
      result[lastKey] = scalarValue(m[2])
      continue
    }
    if (lastKey && /^\s{2,}/.test(line)) {
      const prev = result[lastKey]
      if (typeof prev === 'string' && prev.length > 0) result[lastKey] = `${prev} ${line.trim()}`
    }
  }
  if (typeof result['disable-model-invocation'] === 'boolean') result.modelInvocable = !result['disable-model-invocation']
  if (typeof result['user-invocable'] === 'boolean') result.userInvocable = result['user-invocable']
  return result
}

function scalarValue(raw) {
  let v = raw.trim()
  if (!v) return ''
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  const n = Number(v)
  if (v !== '' && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(v)) return n
  const hash = v.indexOf(' #')
  if (hash > 0) v = v.slice(0, hash).trim()
  return v
}

export function serializeFrontmatter(data) {
  const lines = ['---']
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'boolean' || typeof v === 'number') lines.push(`${k}: ${v}`)
    else {
      const s = String(v)
      if (s.includes('\n')) {
        lines.push(`${k}: >`)
        for (const l of s.split('\n')) lines.push(`  ${l}`)
      } else if (s.includes(':')) {
        lines.push(`${k}: "${s.replace(/"/g, '\\"')}"`)
      } else lines.push(`${k}: ${s}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

export function parseSkillFile(raw) {
  if (!raw.startsWith('---')) return undefined
  const firstEnd = raw.indexOf('\n')
  if (firstEnd < 0) return undefined
  const start = firstEnd + 1
  let bodyStart = -1
  let lineStart = start
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      bodyStart = next < 0 ? raw.length : next + 1
      break
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  if (bodyStart < 0) return undefined
  const data = parseYamlSubset(raw.slice(start, bodyStart - 1))
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined
  const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined
  if (!name || !description || !isSkillName(name)) return undefined
  return {
    name,
    description,
    ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
    frontmatter: data,
    body: raw.slice(bodyStart).trim(),
    raw,
  }
}

/**
 * 技能根解析。root: user(默认,~/.claude/skills) / user-claude / user-zcode|user-dsh(兼容别名) /
 * agents(~/.agents/skills) / project(需 cwd,向上找 .git) / custom(服务配置)。
 */
export function resolveSkillRoot(kind, cwd, customSkillDirs = [], claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), agentsHome = process.env.AGENTS_HOME || path.join(homedir(), '.agents')) {
  const k = kind || 'user'
  switch (k) {
    case 'user':
    case 'user-claude':
    case 'user-zcode':
    case 'user-dsh': // zcode/dsh-web-service 兼容别名
      return { ok: true, root: { kind: 'user', path: path.join(claudeHome, 'skills') } }
    case 'agents':
    case 'user-agents':
      return { ok: true, root: { kind: 'agents', path: path.join(agentsHome, 'skills') } }
    case 'custom': {
      if (!customSkillDirs.length) return { ok: false, error: '该服务未配置自定义技能目录 (customSkillDirs)' }
      return { ok: true, root: { kind: 'custom', path: customSkillDirs[0] } }
    }
    case 'project': {
      if (!cwd) return { ok: false, error: 'root=project 需要提供 cwd 参数' }
      const projectRoot = findProjectRoot(path.resolve(cwd))
      const claude = path.join(projectRoot, '.claude', 'skills')
      const agents = path.join(projectRoot, '.agents', 'skills')
      return { ok: true, root: { kind: 'project', path: existsSync(claude) ? claude : agents } }
    }
    default:
      return { ok: false, error: `未知技能根: ${kind}` }
  }
}

function findProjectRoot(cwd) {
  let current = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

export async function discoverSkills(root) {
  const out = []
  if (!existsSync(root)) return out
  let entries = []
  try { entries = await readdir(root) } catch { return out }
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const full = path.join(root, entry)
    let st
    try { st = await stat(full) } catch { continue }
    let skillPath, skillRoot
    if (st.isDirectory()) {
      skillPath = path.join(full, 'SKILL.md')
      if (!existsSync(skillPath)) continue
      skillRoot = full
    } else if (st.isFile() && entry.endsWith('.md')) {
      skillPath = full
      skillRoot = root
    } else continue
    let raw = ''
    try { raw = await readFile(skillPath, 'utf-8') } catch { continue }
    const parsed = parseSkillFile(raw)
    if (!parsed) continue
    out.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      source: path.basename(root),
      path: skillPath,
      root,
      size: Buffer.byteLength(raw, 'utf-8'),
      modelInvocable: parsed.frontmatter.modelInvocable,
      userInvocable: parsed.frontmatter.userInvocable,
    })
  }
  return out
}

// ---------------- 压缩包解压 ----------------

export async function extractZip(buffer, destDir) {
  try {
    const eocd = findEocd(buffer)
    if (!eocd) return { ok: false, error: '无法定位 ZIP 中央目录 (EOCD)' }
    const { count, centralOffset } = eocd
    await mkdir(destDir, { recursive: true })
    let pos = centralOffset
    let extracted = 0
    for (let i = 0; i < count; i += 1) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) return { ok: false, error: '中央目录条目签名错误' }
      const method = buffer.readUInt16LE(pos + 10)
      const compSize = buffer.readUInt32LE(pos + 20)
      const nameLen = buffer.readUInt16LE(pos + 28)
      const extraLen = buffer.readUInt16LE(pos + 30)
      const commentLen = buffer.readUInt16LE(pos + 32)
      const localOffset = buffer.readUInt32LE(pos + 42)
      const fname = buffer.toString('utf-8', pos + 46, pos + 46 + nameLen)
      pos += 46 + nameLen + extraLen + commentLen
      if (fname.endsWith('/')) continue
      const safe = safeZipName(fname)
      if (!safe) continue
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return { ok: false, error: `local header 签名错误: ${fname}` }
      const lnameLen = buffer.readUInt16LE(localOffset + 26)
      const lextraLen = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lnameLen + lextraLen
      const comp = buffer.subarray(dataStart, dataStart + compSize)
      let out
      if (method === 0) out = comp
      else if (method === 8) out = inflateRawSync(comp)
      else continue
      const target = path.join(destDir, safe)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, out)
      extracted += 1
    }
    return { ok: true, count: extracted }
  } catch (err) {
    return { ok: false, error: `zip 解压失败: ${err?.message || err}` }
  }
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return { count: buffer.readUInt16LE(i + 10), centralOffset: buffer.readUInt32LE(i + 16) }
    }
  }
  return undefined
}

function safeZipName(name) {
  if (name.includes('\0')) return undefined
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return undefined
  for (const seg of normalized.split('/')) {
    if (seg === '..' || seg === '') return undefined
    if (seg.endsWith(':') || /^[A-Za-z]:/.test(seg)) return undefined
  }
  return normalized
}

export async function extractTar(buffer, destDir, strip) {
  const tmp = path.join(process.env.TMPDIR || '/tmp', `zws-skill-tar-${randomUUID().slice(0, 8)}.tar`)
  try {
    await writeFile(tmp, buffer)
    await mkdir(destDir, { recursive: true })
    const args = ['xf', tmp, '-C', destDir]
    if (strip > 0) args.push(`--strip-components=${strip}`)
    await execFileAsync('tar', args, { timeout: 60_000 })
    return { ok: true, count: 0 }
  } catch (err) {
    return { ok: false, error: `tar 解压失败: ${err?.message || err}` }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

export { rm }
