---
name: claude-code-web-service
description: 通过 HTTP + SSE REST API 远程驱动 Claude Code（会话/流式对话/OpenAI 兼容/文件/技能/权限问答桥）。当用户要求通过 API 远程调用 Claude Code、或需要与 zcode-web-service 同形接口对接 Claude Code 时使用。
---

# claude-code-web-service

本机 Claude Code 的 HTTP + SSE 封装（launchd 常驻，默认 `127.0.0.1:3082`，前缀 `/api/v1`）。接口形状与 zcode-web-service / dsh-web-service 一致：信封 `{ok, data?, error?, code?, timestamp}`，鉴权 `Authorization: Bearer <key>` 或 `X-API-Key`。

## 快速用法

```bash
KEY=<from ~/.claude/claude-code-web-service/config.json>; BASE=http://127.0.0.1:3082/api/v1
# 建会话（cwd 必填；mode: default|acceptEdits|plan|bypassPermissions）
SID=$(curl -s -X POST $BASE/sessions -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"cwd":"/path/to/project","mode":"acceptEdits"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["sessionId"])')
# 同步对话 / 流式 / OpenAI 兼容
curl -s -X POST $BASE/sessions/$SID/prompt -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"prompt":"..."}'
curl -sN -X POST $BASE/sessions/$SID/prompt-stream -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"prompt":"..."}'
curl -s $BASE/chat/completions -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}],"cwd":"/tmp"}'
```

## 关键语义

- 会话 id 是服务侧 `cc-…`；进程空闲回收/崩溃后自动 `--resume` 复活，历史不丢。
- 权限：default 模式下工具调用会挂起授权批次（`GET /sessions/:id/questions` → `POST /sessions/:id/answers`，接受 `{action:'accept'|'decline'}` 或 dsh 形状 `{answers:[{id,selected[],custom?}]}`）；AskUserQuestion 走同一桥（`kind:user_input`，含结构化 questions）。
- `bypassPermissions` 只能在会话启动时授予（PUT 对活会话返回 `appliedLive:false`，下次 resume 生效）。
- 超时是停滞看门狗：事件持续就不会被打断；`stallTimeoutMs` 可按请求覆盖。
- goal 为 ZCode 专有（恒 null / 400）；app-registration 恒 501。

完整接口面见 `GET /openapi.json` 或 README。
