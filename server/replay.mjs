// replay.mjs — 事件重放合并：内存 ring（本进程捕获的实时流）为主，
// ring 为空（服务重启后）时从 Claude transcript（~/.claude/projects/.../<id>.jsonl）
// 折叠出历史事件兜底。按 eventId 去重、按 seq 排序。
export async function collectEvents(engine, sessionId, afterSeq) {
  const ringEvents = engine.ring.get(sessionId)?.events ?? []
  let events = []
  const seen = new Set()
  if (afterSeq != null || ringEvents.length === 0) {
    try {
      const store = await engine.transcriptEvents(sessionId)
      for (const ev of store) {
        if (!seen.has(ev.eventId)) { seen.add(ev.eventId); events.push(ev) }
      }
    } catch { /* transcript may not exist; ring may still serve */ }
  }
  for (const ev of ringEvents) {
    if (seen.has(ev.eventId)) continue
    if (afterSeq != null && typeof ev.seq === 'number' && ev.seq <= afterSeq) continue
    seen.add(ev.eventId)
    events.push(ev)
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  let eventSeq = null
  for (const ev of events) if (typeof ev.seq === 'number') eventSeq = Math.max(eventSeq ?? 0, ev.seq)
  if (eventSeq == null) eventSeq = engine.ringEventSeq(sessionId)
  return { sessionId, events, eventSeq }
}
