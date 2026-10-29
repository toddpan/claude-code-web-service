// openapi-spec.mjs — OpenAPI 3.0 规范（路径与摘要对齐 zcode/dsh-web-service openapi）
import { MODES } from '../engine.mjs'

const bearer = [{ bearerAuth: [] }]

function ok(desc = 'ok', schema) {
  return { description: desc, content: { 'application/json': { schema: schema || { type: 'object' } } } }
}
function err(desc) { return { description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } }
function body(schema) { return { required: true, content: { 'application/json': { schema } } } }
function obj(props, required) {
  return { type: 'object', properties: props, ...(required ? { required } : {}) }
}

const Error_ = {
  name: 'Error',
  type: 'object',
  properties: { ok: { type: 'boolean' }, error: { type: 'string' }, code: { type: 'string' }, timestamp: { type: 'number' } },
}

export function buildOpenApiSpec(cfg, version) {
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '会话 ID（Claude session UUID）或工作区路径' }
  const nameParam = { name: 'name', in: 'path', required: true, schema: { type: 'string' } }
  const keyIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
  const uploadIdParam = { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } }

  const paths = {
    '/system/status': { get: { tags: ['system'], summary: '服务与引擎状态', security: bearer, responses: { 200: ok() } } },
    '/system/updates': { get: { tags: ['system'], summary: '检查更新（公开）', security: [], responses: { 200: ok() } } },
    '/ping': { get: { tags: ['system'], summary: '机器指纹（IP/MAC，判定是否本机）', security: bearer, responses: { 200: ok() } } },
    '/healthz': { get: { tags: ['system'], summary: '存活探针（免鉴权）', security: [], responses: { 200: ok() } } },

    '/workspaces': {
      get: { tags: ['workspaces'], summary: '工作区列表', security: bearer, responses: { 200: ok() } },
      post: { tags: ['workspaces'], summary: '登记工作区（目录须存在；幂等）', security: bearer, requestBody: body(obj({ path: { type: 'string' }, title: { type: 'string' } }, ['path'])), responses: { 200: ok(), 201: ok() } },
    },
    '/workspaces/{id}': {
      get: { tags: ['workspaces'], summary: '工作区详情', security: bearer, parameters: [idParam], responses: { 200: ok(), 404: err('not found') } },
      put: { tags: ['workspaces'], summary: '修改工作区标题', security: bearer, parameters: [idParam], requestBody: body(obj({ title: { type: 'string' } }, ['title'])), responses: { 200: ok() } },
      delete: { tags: ['workspaces'], summary: '移除工作区登记', security: bearer, parameters: [idParam], responses: { 200: ok() } },
    },
    '/workspaces/{id}/sessions': {
      get: { tags: ['workspaces'], summary: '工作区下的会话', security: bearer, parameters: [idParam], responses: { 200: ok() } },
    },

    '/sessions': {
      get: { tags: ['sessions'], summary: '会话列表（?search=&workspaceId=&limit=&includeArchived=）', security: bearer, responses: { 200: ok() } },
      post: {
        tags: ['sessions'], summary: '创建会话（spawn claude -p stream-json 长驻进程）', security: bearer,
        requestBody: body(obj({
          cwd: { type: 'string', description: '工作目录（或 workspacePath/workspaceId）' },
          title: { type: 'string', description: '会话名（claude --name，真实生效）' },
          mode: { type: 'string', enum: [...MODES] },
          permission: { type: 'string', description: 'dsh 风格别名：workspace-write/danger-full-access/read-only' },
          model: { type: 'string', description: 'claude 模型 id 或别名（opus/sonnet/haiku）' },
          reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
          sessionId: { type: 'string', description: '传已有 Claude session id 则以 --resume 接管' },
        })),
        responses: { 201: ok(), 400: err('bad request') },
      },
    },
    '/sessions/{id}': {
      get: { tags: ['sessions'], summary: '会话详情', security: bearer, parameters: [idParam], responses: { 200: ok(), 404: err('not found') } },
      put: { tags: ['sessions'], summary: '修改会话（标题 /rename、模型、推理强度、权限模式）', security: bearer, parameters: [idParam], requestBody: body(obj({ title: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' }, agentPreset: { type: 'string' } })), responses: { 200: ok() } },
      delete: { tags: ['sessions'], summary: '关闭会话（结束进程，历史保留在 transcript）', security: bearer, parameters: [idParam], responses: { 200: ok() } },
    },
    '/sessions/{id}/history': { get: { tags: ['sessions'], summary: '会话历史消息（?maxMessages=&beforeSeq=；ring 为空时从 transcript 折叠）', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/sessions/{id}/stats': { get: { tags: ['sessions'], summary: '会话统计（轮次/步数/token 账本/cost）', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/sessions/{id}/todos': { get: { tags: ['sessions'], summary: '任务清单（TodoWrite/TaskCreate/TaskUpdate 折叠，尽力而为）', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/sessions/{id}/skills': { get: { tags: ['sessions'], summary: '会话作用域技能目录', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/sessions/{id}/permission': {
      get: { tags: ['sessions'], summary: '读取运行权限', security: bearer, parameters: [idParam], responses: { 200: ok() } },
      put: { tags: ['sessions'], summary: '切换运行权限（preset，支持 dsh 别名；活会话走 set_permission_mode）', security: bearer, parameters: [idParam], requestBody: body(obj({ preset: { type: 'string' } }, ['preset'])), responses: { 200: ok() } },
    },
    '/sessions/{id}/cancel': { post: { tags: ['sessions'], summary: '取消当前轮次（interrupt control request）', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/sessions/{id}/goal': {
      get: { tags: ['sessions'], summary: '读取会话当前长期目标（claude-code 无目标运行时，恒 null）', security: bearer, parameters: [idParam], responses: { 200: ok() } },
      post: {
        tags: ['sessions'], summary: '创建长期目标（claude-code 无对应能力，400 GOAL_UNSUPPORTED）', security: bearer, parameters: [idParam],
        requestBody: body(obj({ objective: { type: 'string' } }, ['objective'])),
        responses: { 400: err('objective 缺失 / GOAL_UNSUPPORTED') },
      },
      put: {
        tags: ['sessions'], summary: '目标生命周期动作（claude-code 无对应能力，400 GOAL_UNSUPPORTED）', security: bearer, parameters: [idParam],
        requestBody: body(obj({ action: { type: 'string' }, objective: { type: 'string' } }, ['action'])),
        responses: { 400: err('action 非法 / GOAL_UNSUPPORTED') },
      },
    },
    '/sessions/{id}/plan': {
      get: { tags: ['sessions'], summary: '查询计划模式状态（映射 Claude 权限模式 plan）', security: bearer, parameters: [idParam], responses: { 200: ok() } },
      put: {
        tags: ['sessions'], summary: '进入/退出计划模式（set_permission_mode；退出恢复基础模式）', security: bearer, parameters: [idParam],
        requestBody: body(obj({ active: { type: 'boolean' } }, ['active'])),
        responses: { 200: ok(), 400: err('active 必须为 boolean') },
      },
    },
    '/sessions/{id}/compact': {
      post: {
        tags: ['sessions'], summary: '手动压缩会话历史（发会话内 /compact，异步受理）', security: bearer, parameters: [idParam],
        requestBody: body(obj({ instructions: { type: 'string', description: '压缩提示词（可选）' } })),
        responses: { 200: ok('compacted: true, state: accepted'), 409: err('SESSION_NOT_LIVE') },
      },
    },
    '/sessions/{id}/app-registration': {
      get: { tags: ['sessions'], summary: 'APP 任务索引登记状态（ZCode 专有，恒 501 DISABLED）', security: bearer, parameters: [idParam], responses: { 501: err('disabled') } },
      put: { tags: ['sessions'], summary: '登记到 APP 任务索引（ZCode 专有，恒 501）', security: bearer, parameters: [idParam], responses: { 501: err('disabled') } },
      delete: { tags: ['sessions'], summary: '从 APP 任务索引摘除（ZCode 专有，恒 501）', security: bearer, parameters: [idParam], responses: { 501: err('disabled') } },
    },

    '/sessions/{id}/prompt': { post: { tags: ['streaming'], summary: '同步对话（等待本轮 result；停滞看门狗语义——事件持续不会超时）', security: bearer, parameters: [idParam], requestBody: body(obj({ prompt: { type: 'string' }, timeoutMs: { type: 'number', description: '停滞间隔（无事件上限毫秒），默认 cfg.turnStallTimeoutMs' }, stallTimeoutMs: { type: 'number' } }, ['prompt'])), responses: { 200: ok(), 400: err('bad request') } } },
    '/sessions/{id}/prompt-stream': { post: { tags: ['streaming'], summary: 'SSE 流式对话（connected/delta/reasoning/tool_call/tool_result/usage/turn_end/done；15s : ping 心跳）', security: bearer, parameters: [idParam], requestBody: body(obj({ prompt: { type: 'string' }, stallTimeoutMs: { type: 'number', description: '无事件停滞上限毫秒，默认 cfg.turnStallTimeoutMs' } }, ['prompt'])), responses: { 200: { description: 'text/event-stream' } } } },
    '/sessions/{id}/events': { get: { tags: ['streaming'], summary: 'SSE 事件广播（扩展：?afterSeq= 续传、?live=false JSON 重放）', security: bearer, parameters: [idParam, { name: 'afterSeq', in: 'query', schema: { type: 'integer' } }, { name: 'live', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }], responses: { 200: { description: 'text/event-stream' } } } },
    '/chat/completions': {
      post: {
        tags: ['streaming'], summary: 'OpenAI 兼容对话', security: bearer,
        requestBody: body(obj({
          model: { type: 'string', description: 'claude 模型 id（provider/model 兼容写法）' },
          messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: {} } } },
          stream: { type: 'boolean' },
          sessionId: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' }, stallTimeoutMs: { type: 'number' },
        }, ['messages'])),
        responses: { 200: ok(), 400: err('bad request') },
      },
    },

    '/models': { get: { tags: ['models'], summary: '模型列表（别名目录 + 活会话实测模型）', security: bearer, responses: { 200: ok() } } },
    '/models/default': {
      get: { tags: ['models'], summary: '全局默认模型（config.defaultModel）', security: bearer, responses: { 200: ok() } },
      put: { tags: ['models'], summary: '修改全局默认模型（写 config.defaultModel，新会话生效）', security: bearer, requestBody: body(obj({ provider: { type: 'string' }, model: { type: 'string' } })), responses: { 200: ok() } },
    },
    '/providers': { get: { tags: ['models'], summary: '提供方列表（恒 anthropic）', security: bearer, responses: { 200: ok() } } },
    '/presets': { get: { tags: ['models'], summary: 'Agent 预设（无，恒空）', security: bearer, responses: { 200: ok() } } },
    '/settings': { get: { tags: ['models'], summary: '服务设置视图', security: bearer, responses: { 200: ok() } } },
    '/settings/{namespace}': { patch: { tags: ['models'], summary: '更新设置（namespace=web-service）', security: bearer, parameters: [{ name: 'namespace', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body(obj()), responses: { 200: ok() } } },

    '/fs/list': { get: { tags: ['fs'], summary: '目录列表（?path=&all=1）', security: bearer, responses: { 200: ok() } } },
    '/fs/download': { get: { tags: ['fs'], summary: '下载/内联预览绝对路径文件（?path=&inline=1）', security: bearer, responses: { 200: { description: 'file stream' } } } },
    '/fs/mkdir': { post: { tags: ['fs'], summary: '新建目录 {path,name}', security: bearer, requestBody: body(obj({ path: { type: 'string' }, name: { type: 'string' } }, ['path', 'name'])), responses: { 200: ok() } } },
    '/fs/remove': { delete: { tags: ['fs'], summary: '删除文件/目录（?path=）', security: bearer, responses: { 200: ok() } } },
    '/fs/upload': { post: { tags: ['fs'], summary: '向目录上传文件（?path=，multipart 或原始流 ?filename=）', security: bearer, requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } }, 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: ok() } } },

    '/sessions/{id}/files': {
      get: { tags: ['files'], summary: '会话工作区目录列表（?path= 相对路径）', security: bearer, parameters: [idParam], responses: { 200: ok() } },
      post: { tags: ['files'], summary: '上传文件到会话工作区（multipart 或原始流 ?filename=）', security: bearer, parameters: [idParam], requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } }, 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: ok() } },
    },
    '/sessions/{id}/files/download': { get: { tags: ['files'], summary: '下载会话工作区文件（?path=&inline=1）', security: bearer, parameters: [idParam], responses: { 200: { description: 'file stream' } } } },
    '/sessions/{id}/files/resumable': { post: { tags: ['files'], summary: '初始化分片上传（?name=&size=&mimeType=）', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/sessions/{id}/files/resumable/{uploadId}': {
      get: { tags: ['files'], summary: '分片上传进度', security: bearer, parameters: [idParam, uploadIdParam], responses: { 200: ok() } },
      put: { tags: ['files'], summary: '追加分片（?offset=）', security: bearer, parameters: [idParam, uploadIdParam], requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: ok(), 409: err('offset mismatch') } },
      delete: { tags: ['files'], summary: '中止/清理分片上传', security: bearer, parameters: [idParam, uploadIdParam], responses: { 200: ok() } },
    },
    '/sessions/{id}/files/resumable/{uploadId}/complete': { post: { tags: ['files'], summary: '完成分片上传', security: bearer, parameters: [idParam, uploadIdParam], responses: { 200: ok(), 409: err('incomplete') } } },

    '/skills': {
      get: { tags: ['skills'], summary: '技能列表（?root=&cwd=&search=；user=~/.claude/skills）', security: bearer, responses: { 200: ok() } },
      post: { tags: ['skills'], summary: '上传/创建技能（multipart 压缩包或 JSON）', security: bearer, requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } }, 'application/json': { schema: { type: 'object' } } } }, responses: { 200: ok() } },
    },
    '/skills/{name}': {
      get: { tags: ['skills'], summary: '技能详情（含全文）', security: bearer, parameters: [nameParam], responses: { 200: ok(), 404: err('not found') } },
      put: { tags: ['skills'], summary: '更新技能', security: bearer, parameters: [nameParam], requestBody: body(obj()), responses: { 200: ok() } },
      delete: { tags: ['skills'], summary: '删除技能', security: bearer, parameters: [nameParam], responses: { 200: ok() } },
    },
    '/skills/{name}/body': { get: { tags: ['skills'], summary: 'SKILL.md 原始全文', security: bearer, parameters: [nameParam], responses: { 200: { description: 'markdown' } } } },
    '/skills/{name}/archive': { get: { tags: ['skills'], summary: '技能目录归档 (.tgz)', security: bearer, parameters: [nameParam], responses: { 200: { description: 'gzip' } } } },

    '/sessions/{id}/questions': { get: { tags: ['questions'], summary: '挂起的提问/授权批次', security: bearer, parameters: [idParam], responses: { 200: ok() } } },
    '/questions': { get: { tags: ['questions'], summary: '全局挂起批次（附加能力）', security: bearer, responses: { 200: ok() } } },
    '/sessions/{id}/answers': { post: { tags: ['questions'], summary: '答复批次（{action,...} 或 dsh 风格 {answers:[...]}；control_response 桥）', security: bearer, parameters: [idParam], requestBody: body(obj()), responses: { 200: ok(), 404: err('not found'), 409: err('no pending question') } } },

    '/settings/api-keys': { get: { tags: ['keys'], summary: 'API Key 管理页（公开）', security: [], responses: { 200: { description: 'text/html' } } } },
    '/api-keys': {
      get: { tags: ['keys'], summary: 'Key 列表（本机免令牌；远程需管理令牌）', security: bearer, responses: { 200: ok(), 401: err('admin unauthorized（仅远程）') } },
      post: { tags: ['keys'], summary: '新建 Key → 返回明文', security: bearer, requestBody: body(obj({ name: { type: 'string' }, note: { type: 'string' }, expiresInDays: { type: 'number' }, plaintext: { type: 'string' } })), responses: { 201: ok() } },
    },
    '/api-keys/{id}': {
      patch: { tags: ['keys'], summary: '改名/过期', security: bearer, parameters: [keyIdParam], requestBody: body(obj({ name: { type: 'string' }, note: { type: 'string' }, expiresAt: { type: 'number', nullable: true } })), responses: { 200: ok() } },
      delete: { tags: ['keys'], summary: '删除（仅已吊销）', security: bearer, parameters: [keyIdParam], responses: { 200: ok() } },
    },
    '/api-keys/{id}/rotate': { post: { tags: ['keys'], summary: '轮换 → 返回新明文', security: bearer, parameters: [keyIdParam], responses: { 200: ok() } } },
    '/api-keys/{id}/reveal': { post: { tags: ['keys'], summary: '复制（取回明文）', security: bearer, parameters: [keyIdParam], responses: { 200: ok() } } },
    '/api-keys/{id}/revoke': { post: { tags: ['keys'], summary: '吊销（幂等）', security: bearer, parameters: [keyIdParam], responses: { 200: ok() } } },
    '/api-keys/auth': {
      get: { tags: ['keys'], summary: '鉴权状态', security: bearer, responses: { 200: ok() } },
      put: { tags: ['keys'], summary: '鉴权开关 {enabled, confirm?}', security: bearer, requestBody: body(obj({ enabled: { type: 'boolean' }, confirm: { type: 'string' } })), responses: { 200: ok() } },
    },
    '/api-keys/service': {
      get: { tags: ['keys'], summary: 'API 服务状态（端口/监听范围/可达地址列表）', security: bearer, responses: { 200: ok() } },
    },
    '/api-keys/service/free-port': { get: { tags: ['keys'], summary: '建议一个空闲端口（设置/配置参考）', security: bearer, responses: { 200: ok() } } },
    '/api-keys/port': { get: { tags: ['keys'], summary: 'dsh 兼容别名，= /api-keys/service', security: bearer, responses: { 200: ok() } } },
    '/api-keys/service/start': { post: { tags: ['keys'], summary: '启动服务（launchd 托管且已运行 → 恒 501 SERVICE_PROCESS_MANAGED）', security: bearer, responses: { 501: err('service process managed by launchd') } } },
    '/api-keys/service/stop': { post: { tags: ['keys'], summary: '停止服务（同上恒 501；停止请用 launchctl bootout）', security: bearer, responses: { 501: err('service process managed by launchd') } } },

    '/plugins': { get: { tags: ['system'], summary: '本节点插件清单（family=claude-code）', security: bearer, responses: { 200: ok() } } },
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'claude-code-web-service',
      version,
      description: '把 Claude Code 能力开放为 HTTP + SSE API：会话、流式对话、OpenAI 兼容、工作区、模型、文件、技能、提问桥、密钥管理。接口形状对齐 zcode-web-service / dsh-web-service（同一客户端换 baseUrl 即用）。',
    },
    servers: [{ url: `http://127.0.0.1:${cfg.port}/api/v1` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: '数据面 API Key；管理面接口需另带 X-Admin-Token' },
      },
      schemas: { Error: Error_ },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'system' }, { name: 'workspaces' }, { name: 'sessions' }, { name: 'streaming' },
      { name: 'models' }, { name: 'fs' }, { name: 'files' }, { name: 'skills' },
      { name: 'questions' }, { name: 'keys' },
    ],
    paths,
  }
}
