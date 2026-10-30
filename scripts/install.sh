#!/bin/bash
# install.sh — 同步服务端到稳定目录，生成配置与 API Key，注册并启动 launchd 常驻服务。
# 用法: bash scripts/install.sh [--port N] [--remote] [--reset-key] [--claude-bin PATH]
set -euo pipefail

# 支持两种运行方式：本地源码 bash scripts/install.sh，或在线管道
# curl -fsSL https://raw.githubusercontent.com/toddpan/claude-code-web-service/main/scripts/install.sh | bash
# （管道模式下自动下载仓库 tarball 到临时目录作为源）
PLUGIN_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
if [[ -z "$PLUGIN_ROOT" ]]; then
  TMPDL="$(mktemp -d)"
  trap 'rm -rf "$TMPDL"' EXIT
  echo "==> 在线安装：下载仓库到 ${TMPDL}"
  curl -fsSL https://github.com/toddpan/claude-code-web-service/archive/refs/heads/main.tar.gz | tar xz -C "$TMPDL"
  PLUGIN_ROOT="$TMPDL/claude-code-web-service-main"
fi
LABEL="com.claude-code.webservice"
APP_DIR="${HOME}/.claude/claude-code-web-service"
PLIST_SRC="${PLUGIN_ROOT}/launchd/${LABEL}.plist.tpl"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PORT=3082
REMOTE=0
RESET_KEY=0
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    --remote) REMOTE=1; shift;;
    --reset-key) RESET_KEY=1; shift;;
    --claude-bin) CLAUDE_BIN="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node "${HOME}/.local/bin/node"; do
    [[ -x "$c" ]] && NODE_BIN="$c" && break
  done
fi
[[ -n "${NODE_BIN}" ]] || { echo "错误: 未找到 node，请先安装 Node.js >= 18"; exit 1; }
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"

# claude CLI：优先参数/环境变量，其次 PATH 与常见安装位
if [[ -x "$CLAUDE_BIN" && "$CLAUDE_BIN" == /* ]]; then :;
else
  CB="$(command -v "$CLAUDE_BIN" || true)"
  if [[ -z "$CB" ]]; then
    for c in /opt/homebrew/bin/claude /usr/local/bin/claude "${HOME}/.local/bin/claude"; do
      [[ -x "$c" ]] && CB="$c" && break
    done
  fi
  [[ -n "$CB" ]] || { echo "错误: 未找到 claude CLI，请先安装并登录：npm install -g @anthropic-ai/claude-code && claude login"; exit 1; }
  CLAUDE_BIN="$CB"
fi
"$CLAUDE_BIN" --version >/dev/null 2>&1 || { echo "错误: claude CLI 不可执行，请确认已安装并登录（claude login）"; exit 1; }

echo "==> 目标目录: ${APP_DIR}"
mkdir -p "${APP_DIR}/logs"
echo "==> 同步 server/ -> ${APP_DIR}/app/"
rsync -a --delete "${PLUGIN_ROOT}/server/" "${APP_DIR}/app/"
cp -f "${PLUGIN_ROOT}/package.json" "${APP_DIR}/package.json"   # /system/status 版本号来源（service.mjs 读 ../package.json）
if [[ -d "${PLUGIN_ROOT}/vendor" ]]; then
  echo "==> 同步 vendor/ -> ${APP_DIR}/vendor/"
  rsync -a --delete "${PLUGIN_ROOT}/vendor/" "${APP_DIR}/vendor/"
fi

CONFIG="${APP_DIR}/config.json"
if [[ ! -f "$CONFIG" ]]; then
  KEY="ccws_$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p -c 64)"
  cat > "$CONFIG" <<EOF
{
  "port": ${PORT},
  "bind": "127.0.0.1",
  "allowRemote": false,
  "corsOrigins": ["*"],
  "claudeBin": "${CLAUDE_BIN}",
  "defaultMode": "default",
  "defaultModel": "",
  "apiKeys": ["${KEY}"]
}
EOF
  chmod 600 "$CONFIG"
  echo "==> 已生成配置与首个 API Key: ${CONFIG}"
else
  # 用 python3 合并：仅补齐缺失字段；--port/--remote/--reset-key/--claude-bin 生效
  python3 - "$CONFIG" "$PORT" "$REMOTE" "$RESET_KEY" "$CLAUDE_BIN" <<'PYEOF'
import json, sys, secrets
cfg_path, port, remote, reset_key, claude_bin = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4] == "1", sys.argv[5]
cfg = json.load(open(cfg_path))
cfg.setdefault("port", port)
cfg["claudeBin"] = cfg.get("claudeBin") or claude_bin
if remote:
    cfg["bind"] = "0.0.0.0"
    cfg["allowRemote"] = True
if reset_key or not cfg.get("apiKeys"):
    cfg["apiKeys"] = ["ccws_" + secrets.token_hex(24)]
    print("==> 已生成新的 API Key")
json.dump(cfg, open(cfg_path, "w"), ensure_ascii=False, indent=2)
PYEOF
  chmod 600 "$CONFIG"
fi

if [[ "$REMOTE" == "1" ]]; then
  echo "!! 警告: 已开启远程访问 (bind=0.0.0.0, allowRemote=true)。"
  echo "!! 该 API 能驱动 Claude Code 在本机执行命令，请确认 API Key 强度与网络暴露面（防火墙/反代 TLS）。"
fi

echo "==> 写入 launchd plist: ${PLIST_DST}"
mkdir -p "${HOME}/Library/LaunchAgents"
sed -e "s|__NODE__|${NODE_BIN}|g" \
    -e "s|__APP_DIR__|${APP_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__NODE_DIR__|$(dirname "$NODE_BIN")|g" \
    "$PLIST_SRC" > "$PLIST_DST"

echo "==> 加载并启动服务"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
# bootout 是异步的：等标签真正移除再 bootstrap，失败重试两次
for i in 1 2 3; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
    break
  fi
  sleep 2
done
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "==> 等待服务就绪"
PORT_CFG="$(python3 -c "import json;print(json.load(open('$CONFIG'))['port'])")"
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT_CFG}/api/v1/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if curl -sf "http://127.0.0.1:${PORT_CFG}/api/v1/system/status" -H "Authorization: Bearer $(python3 -c "import json;print(json.load(open('$CONFIG'))['apiKeys'][0])")" | grep -q '"ok":true'; then
  echo "✅ 服务已就绪: http://127.0.0.1:${PORT_CFG}"
  echo "   文档:    http://127.0.0.1:${PORT_CFG}/docs"
  echo "   API Key: 请查看 ${CONFIG} (字段 apiKeys)"
  echo "   日志:    ${APP_DIR}/logs/"
else
  echo "⚠️ 服务未在预期时间内就绪，请查看日志: ${APP_DIR}/logs/launchd.err.log"
  exit 1
fi
