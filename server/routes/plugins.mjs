// routes/plugins.mjs — 本节点插件清单（GET /plugins，形状对齐 zcode/dsh-web-service /plugins）
//
// 数据源（按序扫描、去重取最新版本）：
//  1. ~/.claude/plugins 下的仓库/缓存目录（marketplace 安装位与本地 repos）
//  2. cfg.pluginDirs（服务配置补充目录）
//  3. 与服务同级或上一级的 plugin.json（以源仓库形态运行的兜底）
//
// 每条带 `family:'claude-code'`——控制台「从节点导入插件」用家族属性与目标 AGENT
// (DSH / ZCODE / CLAUDE-CODE / 未来扩展) 做适用匹配。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { sendJson } from '../http.mjs'

const CLAUDE_PLUGIN_ROOTS = [join(homedir(), '.claude', 'plugins')]

export function registerPluginRoutes(router, cfg) {
  const extraDirs = (cfg.pluginDirs || []).slice()

  router.get('/plugins', async (_req, res) => {
    try {
      // 同名去重：保留版本号最高的一条
      const rank = (v) => String(v || '0').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0)
      const newer = (a, b) => {
        const ra = rank(a), rb = rank(b)
        for (let i = 0; i < 4; i++) if ((ra[i] || 0) !== (rb[i] || 0)) return (ra[i] || 0) > (rb[i] || 0)
        return false
      }
      const byName = new Map()
      const push = (entry) => {
        if (!entry?.name) return
        const cur = byName.get(entry.name)
        if (cur) {
          if (newer(entry.version, cur.version)) byName.set(entry.name, entry)
          return
        }
        byName.set(entry.name, entry)
      }

      // 1) ~/.claude/plugins 树：扫 manifest.json（marketplace）与各 repo 的 plugin.json / .claude-plugin/plugin.json
      for (const root of CLAUDE_PLUGIN_ROOTS) {
        try {
          for (const entry of walkForManifests(root, 4)) {
            const m = readJsonSafe(entry)
            if (m && typeof m.name === 'string') {
              const srcDir = dirname(entry)
              push({
                name: m.name,
                version: m.version || '0.0.0',
                displayName: m.displayName || m.name,
                description: m.description,
                sourcePath: srcDir,
              })
            }
          }
        } catch { /* 缓存目录不存在则跳过 */ }
      }

      // 2) 配置的额外目录
      for (const dir of extraDirs) {
        if (!dir || !existsSync(dir)) continue
        for (const p of [join(dir, '.claude-plugin', 'plugin.json'), join(dir, 'plugin.json')]) {
          const m = readJsonSafe(p)
          if (m && typeof m.name === 'string') {
            push({ name: m.name, version: m.version, displayName: m.displayName, description: m.description, sourcePath: dir })
          }
        }
      }

      // 3) 当前进程工作目录树上找插件源目录（兜底）
      for (const cand of [nearestManifest(process.cwd()), nearestManifest(dirname(new URL(import.meta.url).pathname))]) {
        if (cand?.manifest) {
          push({ name: cand.manifest.name, version: cand.manifest.version, displayName: cand.manifest.displayName, description: cand.manifest.description, sourcePath: cand.dir })
        }
      }

      const plugins = [...byName.values()]
      return sendJson(res, 200, { ok: true, data: { count: plugins.length, family: 'claude-code', plugins } })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: `读取插件清单失败: ${err?.message || err}`, code: 'INTERNAL_ERROR' })
    }
  })
}

function walkForManifests(root, maxDepth) {
  const out = []
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        visit(full, depth + 1)
      } else if (e.name === 'plugin.json' || e.name === 'manifest.json') {
        out.push(full)
      }
    }
  }
  visit(root, 0)
  return out
}

function readJsonSafe(p) {
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function nearestManifest(startDir) {
  let dir = startDir
  for (let i = 0; i < 3; i++) {
    for (const p of [join(dir, '.claude-plugin', 'plugin.json'), join(dir, 'plugin.json')]) {
      const m = readJsonSafe(p)
      if (m && typeof m.name === 'string') return { dir, manifest: m }
    }
    dir = dirname(dir)
  }
  return null
}
