# claude-code-web-service

把 **Claude Code**（`claude` CLI 的 headless stream-json 协议）封装成 **HTTP + SSE Web 服务**：launchd 常驻、远程可访问。**接口形状对齐 [`zcode-web-service`](https://github.com/toddpan/zcode-web-service) / [`dsh-web-service`](https://github.com/toddpan/dsh-webapi)**——同一个路由族、同一套响应信封 `{ok, data?, error?, code?, timestamp}`、同一套 SSE 事件名，给 zcode-web-service 写的客户端基本可以直接换 baseUrl 使用。

运行时走 Claude Code 官方入口 `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`（与官方 Agent SDK 同一协议），不依赖逆向。

## 架构

```
远程客户端 ──HTTP/SSE──▶ claude-code-web-service (Node, launchd 常驻)
                              │ stream-json (stdio, 行分帧) × 每会话一个 claude 进程
                              ▼
                      claude -p 长驻进程 ──▶ ~/.claude 会话存储（transcript JSONL）
                              │
                              └─ 每会话 MCP / skills / 斜杠命令 / 权限桥照常工作
```

与 ZCode（单 `app-server` 进程多路复用所有会话）不同，Claude Code 是**每会话一个进程**。服务端维护会话进程注册表：空闲进程回收（可配置）、崩溃自动 `--resume` 复活、并发 spawn 去重；会话历史持久在 `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`，服务重启后会话不丢。

服务端模块：`engine.mjs`（claude 会话进程注册表 + stream-json 协议适配 + 权限/问答桥 + 轮次收集）、`http.mjs`（路由/信封/SSE）、`keys-store.mjs`（多 Key 存储 + 管理令牌）、`routes/*`（各业务路由族）、`routes/openapi-spec.mjs`（OpenAPI 3.0）。零 npm 依赖。`vendor/swagger-ui/` 自托管，`/docs` 离线可用。

## 接口面（对齐 zcode-web-service）

鉴权：`Authorization: Bearer <key>` 或 `X-API-Key`（多 Key 管理 + 遗留 config.apiKeys）。管理面（/api-keys*）本机回环免凭证直接管理；仅当配置 `adminRemoteAccess:true` 从远程访问时需 `X-Admin-Token`（令牌文件 `~/.claude/claude-code-web-service/admin-token`）。

| 分组 | 路由 |
|---|---|
| system | `GET /system/status` · `GET /system/updates` · `GET /ping`（IP/MAC 指纹）· `GET /healthz` · `GET /plugins`（family=claude-code） |
| workspaces | `GET/POST /workspaces` · `GET/PUT/DELETE /workspaces/:id` · `GET /workspaces/:id/sessions`（从会话派生 + 标题覆写登记） |
| sessions | `GET/POST /sessions` · `GET/PUT/DELETE /sessions/:id` · `GET /sessions/:id/history` · `GET /sessions/:id/stats` · `GET /sessions/:id/todos` · `GET /sessions/:id/skills` · `GET/PUT /sessions/:id/permission` · `GET/PUT /sessions/:id/plan` · `GET/POST/PUT /sessions/:id/goal`（恒 null/400，见语义差异）· `POST /sessions/:id/compact` · `POST /sessions/:id/cancel` · `GET/PUT/DELETE /sessions/:id/app-registration`（恒 501） |
| streaming | `POST /sessions/:id/prompt`（同步）· `POST /sessions/:id/prompt-stream`（SSE：connected/delta/reasoning/tool_call/tool_result/usage/turn_end/done）· `GET /sessions/:id/events`（SSE 广播；`?afterSeq=` 续传、`?live=false` JSON）· `POST /chat/completions`（OpenAI 兼容） |
| models | `GET /models` · `GET/PUT /models/default` · `GET /providers` · `GET /presets`（恒空）· `GET /settings` · `PATCH /settings/:namespace` |
| fs | `GET /fs/list` · `GET /fs/download` · `POST /fs/mkdir` · `DELETE /fs/remove` · `POST /fs/upload`（multipart 或原始流） |
| files | `GET/POST /sessions/:id/files` · `GET /sessions/:id/files/download` · `POST /sessions/:id/files/resumable` + `GET/PUT/DELETE .../resumable/:uploadId` + `POST .../complete`（分片断点续传） |
| skills | `GET/POST /skills` · `GET /skills/:name` · `GET /skills/:name/body` · `GET /skills/:name/archive`（.tgz）· `PUT/DELETE /skills/:name`（root=user=~/.claude/skills / agents / project / custom） |
| questions | `GET /sessions/:id/questions` · `POST /sessions/:id/answers`（权限授权 + AskUserQuestion 答复桥）· `GET /questions`（全局视角） |
| keys | `GET /settings/api-keys`（管理页）· `GET/POST /api-keys` · `PATCH/DELETE /api-keys/:id` · `POST /api-keys/:id/{rotate,reveal,revoke}` · `GET/PUT /api-keys/auth` · `GET /api-keys/service` + `/free-port` + `/port` · `POST /api-keys/service/{start,stop}`（恒 501，launchd 托管） |
| docs | `GET /docs` · `GET /docs/reference`（Swagger UI）· `GET /openapi.json` |

## 与 zcode-web-service 的语义差异（同一形状，不同底座）

- **引擎模型**：每会话一个 `claude -p` 长驻进程。`POST /sessions` 返回服务侧会话 id（`cc-…`），Claude 真实 session UUID 在首轮 prompt 后捕获（响应附加 `engineSessionId` 字段）；进程空闲回收/崩溃后下次 prompt 自动 `--resume <uuid>` 复活，上下文不丢。
- **权限模式**：`default` / `acceptEdits` / `plan` / `bypassPermissions`。dsh 预设别名映射：`danger-full-access/full/yolo→bypassPermissions`、`workspace-write/build/edit/auto→acceptEdits`、`read-only/plan→plan`、`ask/guarded→default`。注意：CLI 限制 **bypassPermissions 只能在进程启动时授予**，对活会话 PUT 会返回 `appliedLive:false` + `note`，下次 resume 生效；`acceptEdits/plan` 可即时切换（control request）。
- **标题**：Claude Code 支持真重命名——`PUT /sessions/:id {title}` 走会话内 `/rename`，`POST /sessions {title}` 映射 `--name`。
- **模型**：`GET /models` 返回别名目录（opus/sonnet/haiku/opusplan）+ 活会话实测模型；`PUT /models/default` 写 `config.defaultModel`（zcode 返回 501，这里真正可改）；会话级 `PUT /sessions/:id {model}` 即时切换（control request），存量会话下次 resume 以 `--model` 拉起。
- **goal**：Claude Code 无 ZCode 目标运行时——`GET /sessions/:id/goal` 恒 `{goal:null}`，POST/PUT 动作返回 400 `GOAL_UNSUPPORTED`（可用 prompt 下发目标文本替代）。
- **app-registration**：ZCode APP 任务索引为 ZCode 专有，恒 501 `DISABLED`。
- **plan 模式**：映射 Claude 权限模式 `plan`，转换立即生效（`pending` 恒 false）；退出恢复基础模式。
- **compact**：发会话内 `/compact` 斜杠命令，异步受理（`state: accepted`）。
- **提问桥**：底层是 Claude 的 stdout `control_request`（`can_use_tool` 授权 / `AskUserQuestion` 问答）；答复支持 dsh 形状 `{answers:[{id,selected[],custom?}]}` 与原生形状 `{action:'accept'|'decline', reason?}`。`AskUserQuestion` 的应答以 `updatedInput.answers = {"<问题原文>": "<答案>"}` 回传（对齐 cc-connect）。挂起超过 10 分钟自动 deny。
- **统计**：来自 Claude `result` 事件的真账本——`durationMs/ttftMs/numTurns/costUsd`（真实美元成本）与 `usage`（`inputTokens` 已含缓存读/写，同 zcode 账本口径），`/stats` 附加 `costUsd`。
- **todos**：从事件流折叠 `TodoWrite/TaskCreate/TaskUpdate` 工具调用（尽力而为）。
- **历史**：内存 ring 为主；服务重启后 ring 为空时从 `~/.claude/projects/.../<id>.jsonl` transcript 折叠兜底。

## 安装

要求：macOS、Node ≥ 18、[Claude Code CLI](https://docs.claude.com/en/docs/claude-code) 已安装并登录（`claude login`，或配好 `ANTHROPIC_API_KEY`）。

一键在线安装：

```bash
curl -fsSL https://raw.githubusercontent.com/toddpan/claude-code-web-service/main/scripts/install.sh | bash
```

或从源码安装：

```bash
git clone https://github.com/toddpan/claude-code-web-service.git
cd claude-code-web-service
bash scripts/install.sh            # 默认 127.0.0.1:3082
# bash scripts/install.sh --remote # 开放远程访问（确认 Key 强度后）
# bash scripts/install.sh --port 3083 --claude-bin /path/to/claude
```

装完验证：

```bash
curl -s http://127.0.0.1:3082/api/v1/system/status -H "Authorization: Bearer $KEY"
open http://127.0.0.1:3082/api/v1/docs
```

- 数据面 API Key：`~/.claude/claude-code-web-service/config.json` 的 `apiKeys`，日常管理走 `/api/v1/settings/api-keys` 页面（本机打开即用，无需令牌）
- 管理令牌（仅远程管理时需要）：`cat ~/.claude/claude-code-web-service/admin-token`

> launchd 常驻注意：Claude 登录态存于 `~/.claude`（OAuth token 可能经 macOS Keychain 保护）。若服务日志出现鉴权错误，先以同一用户手动 `claude -p "hi"` 验证，或在 config 里改用 API Key 环境（`ANTHROPIC_API_KEY` 经 launchd `EnvironmentVariables` 注入）。

## 快速上手

```bash
KEY=...; BASE=http://127.0.0.1:3082/api/v1

# 建会话并同步对话（等待本轮完成）
SID=$(curl -s -X POST $BASE/sessions -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"cwd":"/tmp","mode":"plan"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["sessionId"])')
curl -s -X POST $BASE/sessions/$SID/prompt -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"prompt":"统计本目录文件数"}'

# 流式对话
curl -sN -X POST $BASE/sessions/$SID/prompt-stream -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"prompt":"继续"}'

# OpenAI 客户端直连（base_url=http://127.0.0.1:3082/api/v1，api_key=$KEY）
curl -s $BASE/chat/completions -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}],"cwd":"/tmp"}'

# 上传文件到会话工作区 → 把返回 path 告诉会话即可被 AI 读取
curl -X POST "$BASE/sessions/$SID/files?filename=a.txt" -H "X-API-Key: $KEY" --data-binary @a.txt
```

## 流式与超时语义

`POST /sessions/:id/prompt-stream` / `POST /sessions/:id/prompt`（同步与 OpenAI 兼容路径同样受益）的超时**不按总运行时长掐断**。当前语义是**停滞看门狗（stall watchdog）**：

- 只要本轮还有会话事件到来（文本/推理/工具调用/工具结果/usage），计时就被**重置**；持续生成、持续工具轮永远不会被打断。
- 间隔默认 `cfg.turnStallTimeoutMs`（config.json 可调，默认 180_000，即"允许 180 秒完全无事件"）；也可用请求体 `timeoutMs` / `stallTimeoutMs` 覆盖。
- 真"无事件停滞"时：引擎主动 interrupt 收口，同步路径返回已收集的部分内容（附 `stalled: true`），流式路径发 `error`（`TURN_TIMEOUT`）后 `done` 收束，SSE 不会无限悬挂。
- SSE 路由（`prompt-stream`、`/events`、OpenAI 流式）自带 15s `: ping` 注释帧心跳，防止中间层/慢客户端空闲断流。
- token 级流式：默认开启 `--include-partial-messages`（config `streamPartial:false` 可关）。

## 配置（~/.claude/claude-code-web-service/config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` / `bind` | 3082 / 127.0.0.1 | 监听端口与地址 |
| `allowRemote` | false | 允许非回环访问（配合 `bind:0.0.0.0`） |
| `pathPrefix` | /api/v1 | 路由前缀 |
| `apiKeys` | [] | 遗留强制鉴权 Key |
| `claudeBin` | claude | claude 可执行文件路径 |
| `defaultMode` | default | 新会话权限模式（default/acceptEdits/plan/bypassPermissions） |
| `defaultModel` | （CLI 默认） | 新会话模型（opus/sonnet/haiku 或完整 id） |
| `turnStallTimeoutMs` | 180000 | 停滞看门狗间隔 |
| `sessionIdleTimeoutMs` | 1800000 | 空闲进程回收（0=不回收） |
| `maxSessions` | 32 | 并发会话进程上限 |
| `streamPartial` | true | token 级流式 |
| `customSkillDirs` | [] | root=custom 技能目录 |
| `workspaces` | [] | 显式声明工作区 `[{path,title?}]` |

## launchd 兼容性说明（重要）

launchd 直接派生树中的 `claude`（Bun 二进制）在部分 macOS 版本上会因 **TCC 归因**在启动阶段静默挂起（零输出，与任何服务端实现无关——最小 launchd agent 直接跑 `claude -p` 即可复现）。本服务的 launchd 模板已用 Apple 自带的 `caffeinate -i` 中转派生（`/usr/bin/caffeinate -i node …/service.mjs`），使责任进程归 Apple 二进制、TCC 自动放行，实测恢复正常。若你手动改写 plist，务必保留 caffeinate 前缀。

## 安全

默认只绑 `127.0.0.1`；`install.sh --remote` 才会 `bind 0.0.0.0 + allowRemote:true`。API Key 管理面默认仅回环；`adminRemoteAccess:true` 放开远程后仍需管理令牌 + 失败限流（10 次/60 秒）。公网暴露务必前置 TLS 反代/防火墙白名单。远程调用慎用 `bypassPermissions`。

## 卸载与排障

```bash
bash scripts/uninstall.sh           # 停服务、删 plist（保留 ~/.claude/claude-code-web-service/）
tail -50 ~/.claude/claude-code-web-service/logs/service.log
launchctl kickstart -k gui/$(id -u)/com.claude-code.webservice   # 改配置后重启
```

| 现象 | 处理 |
|---|---|
| 服务起不来 | `logs/launchd.err.log` / `logs/service.log`；先手动 `claude -p "hi"` 验证 CLI 与登录态 |
| 403 FORBIDDEN_REMOTE | 远端访问未开：config 里 `allowRemote:true` |
| 401 ADMIN_UNAUTHORIZED | 远程管理时令牌错误/缺失：`cat ~/.claude/claude-code-web-service/admin-token` |
| 会话 404 | 会话已 DELETE（索引移除）；历史仍在 transcript，可 `POST /sessions {sessionId:"<claude uuid>"}` 接管 |
| PUT bypassPermissions 返回 appliedLive:false | CLI 限制：bypass 只能在启动时授予；下次 resume 生效，或重建会话 |
