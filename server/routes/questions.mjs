// routes/questions.mjs — 提问/授权答复桥（路由与形状对齐 zcode/dsh user-questions）
// Claude Code 通过 stdout control_request（can_use_tool 授权 / AskUserQuestion 问答）征询客户端；
// 本桥把它们登记为挂起批次，由远程调用方经 REST 查询与答复。
import { sendJson } from '../http.mjs'

export function registerQuestionRoutes(router, engine) {
  // 查询挂起的问题批次
  router.get('/sessions/:id/questions', async (_req, res, p) => {
    const batches = engine.listQuestions(p.id)
    sendJson(res, 200, {
      ok: true,
      data: {
        sessionId: p.id,
        bridge: 'claude-control-v1',
        count: batches.length,
        batches,
      },
    })
  })

  // 全局挂起批次（跨会话，控制台轮询用；dsh 无此路由，附加能力）
  router.get('/questions', async (_req, res) => {
    const batches = engine.listQuestions(null)
    sendJson(res, 200, { ok: true, data: { count: batches.length, batches } })
  })

  // 提交答复
  router.post('/sessions/:id/answers', async (_req, res, p, _q, body) => {
    const list = engine.listQuestions(p.id)
    if (list.length === 0) {
      return sendJson(res, 409, { ok: false, error: '该会话当前没有挂起的问题', code: 'NO_PENDING_QUESTION' })
    }
    const isAnswersShape = body && typeof body === 'object' && Array.isArray(body.answers)
    const isActionShape = body && typeof body === 'object' && typeof body.action === 'string'
    if (!isAnswersShape && !isActionShape) {
      return sendJson(res, 400, { ok: false, error: '需要 {action,...} 或 {answers:[{id,selected[],custom?}]} 形状的答复', code: 'BAD_REQUEST' })
    }
    if (isAnswersShape && body.answers.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'answers 不能为空', code: 'BAD_REQUEST' })
    }
    let batch
    if (typeof body?.batchId === 'string' && body.batchId) {
      batch = list.find(b => b.batchId === body.batchId)
      if (!batch) return sendJson(res, 404, { ok: false, error: `批次 ${body.batchId} 不存在或已答复`, code: 'NOT_FOUND' })
    } else {
      batch = list[0]
    }
    const result = engine.answerQuestion(batch.batchId, body)
    if (!result.ok) {
      return sendJson(res, result.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: result.error, code: result.code })
    }
    sendJson(res, 200, { ok: true, data: { sessionId: p.id, batchId: batch.batchId, answered: result.answered } })
  })
}
