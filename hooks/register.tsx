// xray-loop: records the turn in flight from the engine's own events and draws the
// agent loop, step by step, with the real payloads and a timeline, in a pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TurnRec, View } from '../types'
import { buildEvents, buildSpans, eventAt, lastT } from './loop'
import { Recorder, type CallResultIn } from './recorder'
import { drawPane, timelineWidth } from './view'

const PANE = 'xray-loop'
const NO_VIEW: View = { cursor: null, t: null, item: null, full: false, timeline: true }
const turnAtom = atom({ plugin: 'xray-loop', key: 'turn' } as const, null as TurnRec | null)
const viewAtom = atom({ plugin: 'xray-loop', key: 'view' } as const, NO_VIEW)

const rec = new Recorder()
let lastFlush = 0

// Pushes the record to the pane's state. Throttled while chunks stream; never throws.
async function flush($: EngineInterface, force: boolean): Promise<void> {
  const now = Date.now()
  if (!force && now - lastFlush < 200) return
  lastFlush = now
  const snap = rec.snapshot()
  try {
    await update($, turnAtom, () => snap)
  } catch {
    // the pane is a viewer: a failed write never touches the turn
  }
}

// A new turn always starts followed live, whatever the person was exploring before.
async function followNewTurn($: EngineInterface): Promise<void> {
  try {
    await update($, viewAtom, v => ({ ...NO_VIEW, timeline: v?.timeline ?? true }))
  } catch {
    // best effort
  }
}

function inputOf(e: Record<string, unknown>): string {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...args } = e
  try {
    return JSON.stringify(args)
  } catch {
    return ''
  }
}

function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // recording is best effort
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'xray-loop',
      description: 'X-ray: watch the agent loop live, with the real prompt, stream and tool payloads',
    })
    return next(e)
  })

  on('command.run', { command: 'xray-loop' }, async $ => {
    await update($, viewAtom, () => NO_VIEW)
    await $.ui.open({ id: PANE, title: 'x-ray · loop' })
    return { text: 'x-ray · loop is open. ctrl+x tab focuses it: h/l steps, j/k time (replay), f live, t timeline, v show all.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const before = rec.turnNumber
    safe(() => {
      if (!rec.isRunning && !e.isMeta && !e.command) rec.begin(e.text, Date.now())
    })
    if (rec.turnNumber !== before) void followNewTurn($)
    void flush($, true)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    const before = rec.turnNumber
    safe(() => (e.agentId ? rec.subStart(e.agentId) : rec.markRunning(e.text, Date.now())))
    if (rec.turnNumber !== before) void followNewTurn($)
    void flush($, true)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    safe(() => (e.agentId ? rec.subEnd(e.agentId, e.answer, Date.now()) : rec.finish(e.answer, Date.now())))
    await flush($, true)
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    safe(() => rec.compose(r.sections, Date.now()))
    void flush($, false)
    return r
  })

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    safe(() => rec.describe(e.tool, (r.isDeferred ?? e.isDeferred) === true))
    return r
  })

  on('session.append', async ($, e, next) => {
    const r = await next(e)
    safe(() => rec.row(e.door, e.message, e.agentId, Date.now()))
    void flush($, false)
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const step = rec.stepStart(e, Date.now())
    void flush($, true)
    const it = next(e)
    let item = await it.next()
    while (!item.done) {
      const chunk = item.value
      safe(() => rec.chunk(step, chunk, Date.now()))
      void flush($, chunk.kind === 'tool' || chunk.kind === 'stop')
      yield chunk
      item = await it.next()
    }
    safe(() => rec.stepEnd(step, item.value, Date.now()))
    void flush($, true)
    return item.value
  })

  on('tool.call', async ($, e, next) => {
    safe(() => rec.callStart(e.tool_use_id, e.tool, e.agentId, inputOf(e as Record<string, unknown>), Date.now()))
    void flush($, true)
    const r = await next(e)
    safe(() => rec.callEnd(e.tool_use_id, r as CallResultIn, Date.now()))
    void flush($, true)
    return r
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    safe(() => rec.check(e.tool_use_id, e.tool, e.agentId, r.decision, r.reason, Date.now()))
    void flush($, true)
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    safe(() => rec.spawn(e.tool_use_id, e.subagentType, r.model ?? e.model, r.agentId, e.prompt, Date.now()))
    void flush($, true)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const turn = await read($, turnAtom)
    const stored = await read($, viewAtom)
    const view: View = { ...NO_VIEW, ...stored }
    const events = turn ? buildEvents(turn) : []
    const spans = turn ? buildSpans(turn, events) : []
    const lastIdx = Math.max(0, events.length - 1)
    const total = turn ? lastT(turn) : 0
    const at = view.t === null ? null : Math.min(view.t, total)
    const cursor = at !== null ? eventAt(events, at) : view.cursor === null ? lastIdx : Math.min(view.cursor, lastIdx)
    const follow = view.cursor === null && view.t === null
    const T = at ?? (follow ? total : (events[cursor]?.t ?? 0))
    const cell = Math.max(1, total / timelineWidth(e.props.bodyColumns))
    return drawPane(el, {
      turn,
      events,
      spans,
      cursor,
      view,
      T,
      at,
      cols: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      act: {
        prev: () => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, cursor: Math.max(0, cursor - 1), t: null, full: false })),
        next: () => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, cursor: cursor + 1 >= lastIdx ? null : cursor + 1, t: null, full: false })),
        follow: () => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, cursor: follow ? cursor : null, t: null })),
        pick: item => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, item, full: false })),
        full: () => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, full: !v.full })),
        jump: event => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, cursor: event, t: null, full: false })),
        scrub: dir => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, t: Math.max(0, Math.min(total, (v.t ?? T) + dir * cell)), full: false })),
        timeline: () => void update($, viewAtom, v => ({ ...NO_VIEW, ...v, timeline: !(v.timeline ?? true) })),
      },
    })
  })
}
