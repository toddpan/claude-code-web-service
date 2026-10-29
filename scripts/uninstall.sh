#!/bin/bash
# uninstall.sh — 停服务、删 plist（保留 ~/.claude/claude-code-web-service/ 数据与配置）
set -euo pipefail
LABEL="com.claude-code.webservice"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "${HOME}/Library/LaunchAgents/${LABEL}.plist"
echo "✅ 已停止并移除 launchd 服务（数据保留在 ~/.claude/claude-code-web-service/，如需彻底清除请手动删除）"
