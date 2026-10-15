// Turns the record of a turn into the steps of the agent loop the pane walks:
// 1 build prompt → 2 send → 3 stream → 4 permission → 5 run tool → 6 add results → 7 answer.

import type { Row, Step, TurnRec } from '../types'

export type LoopKind = 'prompt' | 'request' | 'stream' | 'check' | 'tool' | 'sub' | 'rows' | 'answer'

export type LoopEvent = {
  key: string
  node: 1 | 2 | 3 | 4 | 5 | 6 | 7
  kind: LoopKind
  title: string
  t: number
  isOpen: boolean
  sub: boolean
  round: number
  step?: number
  run?: number
  spawn?: number
  rows?: [number, number]
}

export const NODES = ['build prompt', 'send', 'stream', 'permission', 'run tool', 'add results', 'answer'] as const

// Indexes [from, to) of the rows appended in (after, until].
export function rowsBetween(rows: readonly Row[], after: number, until: number): [number, number] {
  let from = rows.findIndex(r => r.t > after)
  if (from < 0) from = rows.length
  let to = from
  while (to < rows.length && rows[to]!.t <= until) to += 1
  return [from, to]
}

export function firstContent(step: Step): number | undefined {
  return step.chunks.find(c => c.k !== 'stop')?.t
}

// The latest moment the record knows of: the turn's end, or its newest event while live.
export function lastT(turn: TurnRec): number {
  if (turn.t1 !== undefined) return turn.t1
  let t = 0
  for (const r of turn.rows) t = Math.max(t, r.t)
  for (const s of turn.steps) t = Math.max(t, s.t1 ?? s.chunks[s.chunks.length - 1]?.t ?? s.t0)
  for (const r of turn.runs) t = Math.max(t, r.t1 ?? r.t0)
  for (const s of turn.spawns) t = Math.max(t, s.t1 ?? s.t)
  return t
}

export type SpanKind = 'motor' | 'model' | 'tool' | 'sub'

export type Span = {
  key: string
  label: string
  kind: SpanKind
  depth: number
  t0: number
  t1?: number
  ttft?: number
  check?: number
  event: number
  inSub: boolean
}

// The event a moment in the turn belongs to: the latest one that had started by then.
export function eventAt(events: readonly LoopEvent[], t: number): number {
  let best = 0
  let bestT = -Infinity
  events.forEach((e, i) => {
    if (e.t <= t && e.t >= bestT) {
      best = i
      bestT = e.t
    }
  })
  return best
}

// The turn as a waterfall: each model request, each tool and each subagent, nested,
// every span pointing at the loop event that shows its payload.
export function buildSpans(turn: TurnRec, events: readonly LoopEvent[]): Span[] {
  const at = (key: string) => Math.max(0, events.findIndex(e => e.key === key))
  const main = turn.steps.filter(s => !s.agentId)
  const spans: Span[] = [{
    key: 'prompt', label: 'builds the prompt', kind: 'motor', depth: 0, t0: turn.sectionsAt ?? 0, t1: main[0]?.t0 ?? (turn.isOpen ? undefined : turn.t1),
    event: at('prompt'), inSub: false,
  }]
  main.forEach((step, i) => {
    const next = main[i + 1]
    const end = next ? next.t0 : Infinity
    const fc = firstContent(step)
    const answers = events.some(e => e.key === `ans${i}`)
    spans.push({
      key: `step${i}`, label: `step #${i} → model`, kind: 'model', depth: 0, t0: step.t0, t1: step.t1,
      ttft: fc === undefined ? undefined : fc - step.t0, event: at(answers ? `ans${i}` : `str${i}`), inSub: false,
    })
    turn.runs.forEach((run, k) => {
      if (run.agentId || run.t0 < step.t0 || run.t0 >= end) return
      spans.push({ key: `run${k}`, label: run.tool, kind: 'tool', depth: 1, t0: run.t0, t1: run.t1, check: run.tCheck, event: at(`run${k}`), inSub: false })
      const sp = turn.spawns.findIndex(s => s.toolUseId === run.id)
      const spawn = turn.spawns[sp]
      if (!spawn) return
      const ev = at(`sub${sp}`)
      spans.push({ key: `sub${sp}`, label: `subagent ${spawn.type}`, kind: 'sub', depth: 2, t0: spawn.t, t1: spawn.t1, event: ev, inSub: true })
      if (!spawn.agentId) return
      const inner: Span[] = []
      turn.steps.forEach((s, j) => {
        if (s.agentId !== spawn.agentId) return
        const sfc = firstContent(s)
        inner.push({ key: `sstep${j}`, label: `step #${s.index} → model`, kind: 'model', depth: 3, t0: s.t0, t1: s.t1, ttft: sfc === undefined ? undefined : sfc - s.t0, event: ev, inSub: true })
      })
      turn.runs.forEach((r, j) => {
        if (r.agentId !== spawn.agentId) return
        inner.push({ key: `srun${j}`, label: r.tool, kind: 'tool', depth: 3, t0: r.t0, t1: r.t1, check: r.tCheck, event: ev, inSub: true })
      })
      spans.push(...inner.sort((a, b) => a.t0 - b.t0))
    })
  })
  return spans
}

export function buildEvents(turn: TurnRec): LoopEvent[] {
  const main = turn.steps.filter(s => !s.agentId)
  const events: LoopEvent[] = []
  const firstT0 = main[0]?.t0 ?? Infinity
  events.push({
    key: 'prompt', node: 1, kind: 'prompt', title: 'Builds the prompt', t: turn.sectionsAt ?? 0,
    isOpen: main.length === 0 && turn.isOpen, sub: false, round: 1, rows: rowsBetween(turn.rows, -1, firstT0),
  })

  main.forEach((step, i) => {
    const si = turn.steps.indexOf(step)
    const next = main[i + 1]
    const end = next ? next.t0 : Infinity
    const round = i + 1
    const open = step.t1 === undefined
    const after = i === 0 ? -1 : main[i - 1]!.t0

    events.push({
      key: `req${i}`, node: 2, kind: 'request', title: `Sends request #${i}`, t: step.t0,
      isOpen: open, sub: false, round, step: si, rows: rowsBetween(turn.rows, i === 0 ? -1 : after, step.t0),
    })
    const answers = step.stop === 'end_turn' || step.chunks.some(c => c.k === 'text')
    events.push({
      key: `str${i}`, node: 3, kind: 'stream', title: answers ? 'The stream brings the answer' : `Stream #${i}`,
      t: firstContent(step) ?? step.t0, isOpen: open, sub: false, round, step: si,
    })

    turn.runs.forEach((run, k) => {
      if (run.agentId || run.t0 < step.t0 || run.t0 >= end) return
      if (run.decision !== undefined) {
        events.push({
          key: `chk${k}`, node: 4, kind: 'check', title: `Permission for ${run.tool}?`, t: run.tCheck ?? run.t0,
          isOpen: false, sub: false, round, run: k,
        })
      }
      events.push({
        key: `run${k}`, node: 5, kind: 'tool', title: `Runs ${run.tool}`, t: run.t0,
        isOpen: run.t1 === undefined, sub: false, round, run: k,
      })
      const sp = turn.spawns.findIndex(s => s.toolUseId === run.id)
      if (sp >= 0) {
        events.push({
          key: `sub${sp}`, node: 5, kind: 'sub', title: `Subagent ${turn.spawns[sp]!.type} at work`,
          t: turn.spawns[sp]!.t, isOpen: turn.spawns[sp]!.t1 === undefined, sub: true, round, spawn: sp,
        })
      }
    })

    if (step.stop === 'end_turn' || (!next && answers)) {
      events.push({
        key: `ans${i}`, node: 7, kind: 'answer', title: 'Answers and closes the turn', t: step.t1 ?? step.t0,
        isOpen: turn.isOpen, sub: false, round, step: si, rows: rowsBetween(turn.rows, step.t1 ?? step.t0, Infinity),
      })
    } else if (step.t1 !== undefined) {
      const range = rowsBetween(turn.rows, step.t1, end)
      if (range[1] > range[0] || next) {
        events.push({
          key: `rows${i}`, node: 6, kind: 'rows', title: 'Adds the results to the conversation', t: turn.rows[range[0]]?.t ?? step.t1,
          isOpen: !next && turn.isOpen, sub: false, round, rows: range,
        })
      }
    }
  })
  return events
}
