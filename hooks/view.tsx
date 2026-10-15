// Draws the pane: a header with the loop's seven steps, the turn's timeline, then the
// real payload of the step under the cursor. Pure presentation: elements and handlers
// come from the caller. With `at` set, every view shows the turn as it stood then.

import type { Elements } from 'claude-code'

import type { ChunkKind, Row, Step, TurnRec, View } from '../types'
import { NODES, firstContent, lastT, type LoopEvent, type Span, type SpanKind } from './loop'

type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

export type Actions = {
  prev: () => void
  next: () => void
  follow: () => void
  pick: (item: string) => void
  full: () => void
  jump: (event: number) => void
  scrub: (dir: -1 | 1) => void
  timeline: () => void
}

export type PaneData = {
  turn: TurnRec | null
  events: LoopEvent[]
  spans: Span[]
  cursor: number
  view: View
  // the playhead (ms from the turn's start) and, while replaying, the moment shown
  T: number
  at: number | null
  cols: number
  rows: number
  act: Actions
}

const C = {
  model: '#58a6ff',
  tool: '#f0883e',
  sub: '#d2a8ff',
  perm: '#e3b341',
  add: '#3fb950',
  you: '#e6edf3',
  dim: '#8b949e',
  faint: '#484f58',
}

const DOORS: Record<string, [string, string]> = {
  prompt: ['prompt', C.you],
  attachment: ['attach', C.dim],
  'hook-context': ['hook', C.tool],
  response: ['response', C.model],
  'tool-result': ['result', C.add],
  'tool-message': ['tool', C.add],
  queue: ['queue', C.sub],
  delivery: ['delivery', C.perm],
  note: ['note', C.sub],
  notice: ['notice', C.dim],
  command: ['command', C.you],
  compaction: ['compact', C.perm],
}

const KIND_COLOR: Record<ChunkKind, string> = { thinking: C.dim, tool: C.tool, input: '#79c0ff', text: C.you, stop: C.perm }
const SPAN_COLOR: Record<SpanKind, string> = { motor: C.dim, model: C.model, tool: C.tool, sub: C.sub }

const LABEL = 24
const DUR = 8

export function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function secs(ms: number): string {
  return (ms / 1000).toFixed(2) + ' s'
}

function dur(ms: number): string {
  return ms >= 1000 ? secs(ms) : `${Math.round(ms)} ms`
}

function k(n: number | undefined): string {
  return n === undefined ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length)
}

function firstLine(s: string): string {
  return (s.split('\n').find(l => l.trim() !== '') ?? '').trim()
}

export function clipLines(text: string, maxLines: number, width: number): { text: string; more: number } {
  const lines = text.split('\n')
  const out: string[] = []
  let used = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const cost = Math.max(1, Math.ceil(line.length / Math.max(20, width)))
    if (used + cost > maxLines) return { text: out.join('\n'), more: lines.length - i }
    out.push(line)
    used += cost
  }
  return { text: out.join('\n'), more: 0 }
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

// Cells the timeline's bars take at this width.
export function timelineWidth(cols: number): number {
  return Math.max(16, Math.min(96, cols - LABEL - DUR - 6))
}

// A step as it stood at `at`: only the chunks that had arrived, and no stop yet.
export function stepAt(step: Step, at: number | null): Step {
  if (at === null || (step.t1 !== undefined && at >= step.t1)) return step
  return { ...step, chunks: step.chunks.filter(c => c.t <= at), t1: undefined, stop: undefined, usage: undefined }
}

type Block = { i: number; kind: 'thinking' | 'tool' | 'text'; name: string; text: string; closed: boolean }

export function assemble(step: Step): Block[] {
  const blocks: Block[] = []
  const at = new Map<number, Block>()
  for (const c of step.chunks) {
    if (c.k === 'stop') continue
    let b = at.get(c.i)
    if (!b) {
      b = { i: c.i, kind: c.k === 'input' || c.k === 'tool' ? 'tool' : c.k, name: '', text: '', closed: false }
      at.set(c.i, b)
      blocks.forEach(prev => (prev.closed = true))
      blocks.push(b)
    }
    if (c.k === 'tool') b.name = c.s
    else if (c.k === 'input' || c.k === 'text') b.text += c.s
  }
  if (step.t1 !== undefined || step.stop !== undefined) blocks.forEach(b => (b.closed = true))
  return blocks
}

function slice(d: PaneData, range: [number, number] | undefined): Row[] {
  const rows = range ? d.turn!.rows.slice(range[0], range[1]) : []
  return d.at === null ? rows : rows.filter(r => r.t <= d.at!)
}

function rowLine(el: El, r: Row, plus: boolean, preview: boolean): JSX.Element {
  const { Box, Text } = el
  const door = DOORS[r.door] ?? [r.door, C.dim]
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={C.add}>{plus ? '+ ' : '  '}</Text>
        <Text color={door[1]}>{pad(door[0], 9)}</Text>
        {pad(r.name, 28)}
        <Text dimColor>{r.chars ? fmt(r.chars) : 'empty'}</Text>
      </Text>
      {preview && r.chars > 0 && <Text dimColor wrap="truncate-end">{'    ' + firstLine(r.text)}</Text>}
    </Box>
  )
}

function usageLine(el: El, step: Step): JSX.Element {
  const { Text } = el
  const first = firstContent(step)
  if (!step.usage) {
    return <Text dimColor>{first === undefined ? 'waiting for the first token…' : 'the stream is still open…'}</Text>
  }
  const u = step.usage
  return (
    <Text>
      <Text color={C.model}>{`cache read ${fmt(u.cacheRead)}`}</Text>
      <Text color={C.tool}>{` · written ${fmt(u.cacheWrite)}`}</Text>
      {` · output ${fmt(u.output)}`}
      <Text dimColor>{first === undefined ? '' : ` · first content ${dur(first - step.t0)} after sending`}</Text>
    </Text>
  )
}

function textBox(el: El, d: PaneData, title: string, meta: string, text: string, lines: number): JSX.Element {
  const { Box, Text, Button } = el
  const max = d.view.full ? 400 : lines
  const shown = clipLines(text, max, d.cols - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#30363d" paddingX={1}>
      <Text>
        <Text bold>{title}</Text>
        <Text dimColor>{meta ? '  ' + meta : ''}</Text>
      </Text>
      <Text>{shown.text || ' '}</Text>
      {(shown.more > 0 || d.view.full) && (
        <Button key="full" hotkey="v" plain onPress={d.act.full}>
          <Text dimColor>{d.view.full ? 'show less' : `… ${shown.more} more lines · show all`}</Text>
        </Button>
      )}
    </Box>
  )
}

// One bar of the waterfall as runs of same-colored cells, the playhead drawn across it.
function barCells(span: Span, W: number, total: number, now: number, head: number): { s: string; color: string }[] {
  const cells: { s: string; color: string }[] = []
  const t1 = span.t1 ?? now
  const color = span.inSub && span.kind !== 'tool' ? C.sub : SPAN_COLOR[span.kind]
  const first = span.ttft === undefined ? t1 : span.t0 + span.ttft
  const c0 = Math.min(W - 1, Math.floor((span.t0 / total) * W))
  const c1 = Math.max(c0, Math.min(W - 1, Math.ceil((t1 / total) * W) - 1))
  const check = span.check === undefined ? -1 : Math.min(W - 1, Math.floor((span.check / total) * W))
  for (let c = 0; c < W; c += 1) {
    const mid = ((c + 0.5) / W) * total
    let cell = { s: ' ', color: C.faint }
    if (c >= c0 && c <= c1) cell = mid < first && span.ttft !== undefined ? { s: '░', color } : { s: '█', color }
    if (c === check) cell = { s: '◆', color: C.perm }
    if (c === head) cell = { s: cell.s === ' ' ? '│' : '┃', color: C.you }
    cells.push(cell)
  }
  const runs: { s: string; color: string }[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color) last.s += cell.s
    else runs.push({ ...cell })
  }
  return runs
}

function timelineView(el: El, d: PaneData): JSX.Element {
  const { Box, Text, Button } = el
  const turn = d.turn!
  if (!d.view.timeline) {
    return <Button key="tl-toggle" hotkey="t" label="timeline" onPress={d.act.timeline} />
  }
  const W = timelineWidth(d.cols)
  const now = lastT(turn)
  const total = Math.max(1, now)
  const head = Math.min(W - 1, Math.max(0, Math.floor((d.T / total) * W)))
  const maxRows = Math.max(5, Math.min(14, Math.floor(d.rows / 3)))
  const current = d.spans.map(s => s.event).lastIndexOf(d.cursor)
  const start = d.spans.length <= maxRows ? 0 : Math.max(0, Math.min(d.spans.length - maxRows, (current < 0 ? 0 : current) - Math.floor(maxRows / 2)))
  const shown = d.spans.slice(start, start + maxRows)

  const ruler = Array.from({ length: W }, () => ' ')
  for (const q of [0, 0.25, 0.5, 0.75]) {
    const label = `${((q * total) / 1000).toFixed(q === 0 ? 0 : 1)}s`
    const at = Math.floor(q * W)
    for (let i = 0; i < label.length && at + i < W; i += 1) ruler[at + i] = label[i]!
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{pad('', LABEL) + ruler.join('')}</Text>
      {start > 0 && <Text dimColor>{`  ↑ ${start} earlier spans`}</Text>}
      {shown.map(s => {
        const on = s.event === d.cursor
        const label = ' '.repeat(Math.min(6, s.depth * 2)) + s.label
        const color = s.inSub && s.kind !== 'tool' ? C.sub : SPAN_COLOR[s.kind]
        return (
          <Button key={'sp:' + s.key} plain onPress={() => d.act.jump(s.event)}>
            <Text color={on ? C.you : color} bold={on}>{(on ? '▸' : ' ') + pad(label, LABEL - 1)}</Text>
            {barCells(s, W, total, now, head).map(r => <Text color={r.color}>{r.s}</Text>)}
            <Text dimColor>{' ' + pad(s.t1 === undefined ? '…' : dur(s.t1 - s.t0), DUR)}</Text>
          </Button>
        )
      })}
      {start + maxRows < d.spans.length && <Text dimColor>{`  ↓ ${d.spans.length - start - maxRows} later spans`}</Text>}
      <Text color={C.you}>{pad('', LABEL) + ' '.repeat(head) + '▲' + `  ${secs(d.T)}`}</Text>
      <Box columnGap={1} flexWrap="wrap">
        <Button key="tl-back" hotkey="j" label="◂ time" onPress={() => d.act.scrub(-1)} />
        <Button key="tl-fwd" hotkey="k" label="time ▸" onPress={() => d.act.scrub(1)} />
        <Button key="tl-toggle" hotkey="t" label="hide" onPress={d.act.timeline} />
        {d.at === null
          ? <Text dimColor>click a span to open its step · j/k move the playhead</Text>
          : <Text color={C.perm}>{`◷ replay: the turn as it stood at ${secs(d.at)} · f goes back live`}</Text>}
      </Box>
    </Box>
  )
}

function promptView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text, Button } = el
  const turn = d.turn!
  const wide = d.cols >= 100
  const [a] = ev.rows ?? [0, 0]
  const all = slice(d, ev.rows).map((r, i) => ({ r, idx: a + i }))
  const shown = all.filter(x => x.r.chars > 0)
  const empties = all.length - shown.length
  const sysChars = turn.sections.reduce((s, x) => s + x.chars, 0)
  const loaded = turn.tools.filter(t => !t.deferred)
  const deferred = turn.tools.length - loaded.length
  const req0 = turn.steps.find(s => !s.agentId)
  const lastShared = turn.sections.map(s => s.scope).lastIndexOf('shared')
  const item = d.view.item ?? (turn.sections[0] ? 's:' + turn.sections[0].id : shown[0] ? 'r:' + shown[0].idx : '')

  const system = (
    <Box flexDirection="column" width={wide ? 34 : undefined}>
      <Text>
        <Text bold>system</Text>
        <Text dimColor>{` · ${turn.sections.length} sections · ${fmt(sysChars)}`}</Text>
      </Text>
      {turn.sectionsReused && <Text dimColor>same as the previous turn</Text>}
      {turn.sections.length === 0 && <Text dimColor>prompt.compose has not run yet</Text>}
      {turn.sections.flatMap((s, i) => {
        const key = 's:' + s.id
        const btn = (
          <Button key={key} plain onPress={() => d.act.pick(key)}>
            {(item === key ? '▸ ' : '  ') + pad(s.id, 21)}
            <Text dimColor>{fmt(s.chars)}</Text>
          </Button>
        )
        return i === lastShared ? [btn, <Text color={C.perm}>── cache boundary ──</Text>] : [btn]
      })}
    </Box>
  )

  const tools = (
    <Box flexDirection="column" width={wide ? 26 : undefined}>
      <Text>
        <Text bold>tools</Text>
        <Text dimColor>{` · ${loaded.length} + ${deferred}`}</Text>
      </Text>
      {wide && loaded.slice(0, 16).map(t => <Text wrap="truncate-end">{t.name.replace(/^mcp__/, '')}</Text>)}
      {wide && loaded.length > 16 && <Text dimColor>{`+${loaded.length - 16} more`}</Text>}
      <Text dimColor>{`${deferred} deferred: only the name travels`}</Text>
    </Box>
  )

  const messages = (
    <Box flexDirection="column" flexGrow={1}>
      <Text>
        <Text bold>messages</Text>
        <Text dimColor>{req0 ? ` · ${req0.messageCount} in request #0` : ' · the request has not gone out yet'}</Text>
      </Text>
      {turn.before.rows > 0 && <Text dimColor>{`+ ${turn.before.rows} rows from earlier turns · ${fmt(turn.before.chars)} chars`}</Text>}
      {shown.slice(0, 22).map(({ r, idx }) => {
        const key = 'r:' + idx
        const door = DOORS[r.door] ?? [r.door, C.dim]
        return (
          <Button key={key} plain onPress={() => d.act.pick(key)}>
            {item === key ? '▸ ' : '  '}
            <Text color={door[1]}>{pad(door[0], 9)}</Text>
            {pad(r.name, 26)}
            <Text dimColor>{fmt(r.chars)}</Text>
          </Button>
        )
      })}
      {shown.length > 22 && <Text dimColor>{`+ ${shown.length - 22} more rows`}</Text>}
      {empties > 0 && <Text dimColor>{`+ ${empties} empty rows (hooks)`}</Text>}
    </Box>
  )

  let preview: JSX.Element = <Text dimColor>Pick a section or a row to read its text.</Text>
  if (item.startsWith('s:')) {
    const s = turn.sections.find(x => 's:' + x.id === item)
    if (s) preview = textBox(el, d, `system · ${s.id}`, `${s.scope === 'shared' ? 'shared: before the cache boundary' : 'session: after the boundary'} · ${fmt(s.chars)} chars`, s.text, 8)
  } else if (item.startsWith('r:')) {
    const r = turn.rows[Number(item.slice(2))]
    if (r) preview = textBox(el, d, `messages · ${r.name}`, `${(DOORS[r.door] ?? [r.door])[0]} · ${fmt(r.chars)} chars`, r.text, 8)
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection={wide ? 'row' : 'column'} columnGap={2} rowGap={1}>
        {system}
        {tools}
        {messages}
      </Box>
      {preview}
    </Box>
  )
}

function requestView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text } = el
  const turn = d.turn!
  const step = stepAt(turn.steps[ev.step ?? 0]!, d.at)
  const rows = slice(d, ev.rows)
  const shown = rows.filter(r => r.chars > 0)
  const sys = turn.sections.reduce((s, x) => s + x.chars, 0)
  const loaded = turn.tools.filter(t => !t.deferred).length
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        {`POST /v1/messages · ${step.model} · `}
        <Text color={C.model}>{`${step.messageCount} messages`}</Text>
        <Text dimColor>{` · system ${fmt(sys)} chars · ${loaded} tools + ${turn.tools.length - loaded} deferred`}</Text>
      </Text>
      <Box flexDirection="column">
        <Text>
          <Text bold>{ev.key === 'req0' ? 'what it carries' : 'new since the previous request'}</Text>
          <Text dimColor>{` · ${shown.length} rows${rows.length > shown.length ? ` + ${rows.length - shown.length} empty` : ''}`}</Text>
        </Text>
        {shown.slice(-16).map(r => rowLine(el, r, ev.key !== 'req0', true))}
      </Box>
      {usageLine(el, step)}
    </Box>
  )
}

function streamView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text, Code } = el
  const step = stepAt(d.turn!.steps[ev.step ?? 0]!, d.at)
  const recent = step.chunks.slice(-12)
  const accent = step.agentId ? C.sub : C.model
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          <Text bold>chunks</Text>
          <Text dimColor>{` · ${step.chunks.length}${step.dropped ? ` (+${step.dropped} merged)` : ''} · ${step.t1 === undefined ? 'arriving' : `stop ${step.stop ?? ''}`}`}</Text>
        </Text>
        {recent.length === 0 && <Text dimColor>no chunk has arrived yet</Text>}
        {recent.map(c => (
          <Text wrap="truncate-end">
            <Text dimColor>{pad((c.t / 1000).toFixed(3), 9)}</Text>
            <Text color={KIND_COLOR[c.k]}>{pad(c.k, 9)}</Text>
            {c.k === 'thinking' && !c.s ? '(no visible text)' : c.k === 'tool' || c.k === 'stop' ? c.s : JSON.stringify(c.s)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>what is being assembled</Text>
        {assemble(step).map(b => (
          <Box flexDirection="column">
            <Text color={b.closed ? undefined : accent} dimColor={b.closed}>
              {(b.kind === 'tool' ? `tool_use ${b.name}` : b.kind) + (b.closed ? '  ✓ closed' : '  ▍ arriving')}
            </Text>
            {b.kind === 'tool' && <Code language="json" source={b.text || ' '} wrap="wrap" />}
            {b.kind === 'text' && <Text>{b.text}</Text>}
            {b.kind === 'thinking' && <Text dimColor>(thinking text does not travel in the stream)</Text>}
          </Box>
        ))}
      </Box>
      {usageLine(el, step)}
    </Box>
  )
}

function checkView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text, Code } = el
  const run = d.turn!.runs[ev.run ?? 0]!
  const verdict = run.reason ? { decision: run.decision, reason: run.reason } : { decision: run.decision }
  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="truncate-end">
        {'tool.check · '}
        <Text color={C.tool}>{run.tool}</Text>
        <Text dimColor>{'  ' + firstLine(run.input)}</Text>
      </Text>
      <Code language="json" source={JSON.stringify(verdict, null, 2)} wrap="wrap" />
    </Box>
  )
}

function toolView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text, Code } = el
  const turn = d.turn!
  const run = turn.runs[ev.run ?? 0]!
  const running = run.t1 === undefined || (d.at !== null && d.at < run.t1)
  const meta = running
    ? `running · ${dur((d.at ?? lastT(turn)) - run.t0)}`
    : `${fmt(run.resultChars ?? 0)} chars for the model · ${dur(run.t1! - run.t0)}${run.isError ? ' · error' : ''}`
  const result = running ? (d.at === null ? '(still running)' : '(it had not finished yet at this moment)') : (run.result ?? '')
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>input</Text>
        <Code language="json" source={pretty(run.input) || ' '} wrap="wrap" />
      </Box>
      {textBox(el, d, 'result', meta, result, Math.max(6, d.rows - 34))}
    </Box>
  )
}

function subView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text } = el
  const turn = d.turn!
  const sp = turn.spawns[ev.spawn ?? 0]!
  const until = d.at ?? Infinity
  const steps = turn.steps.filter(s => s.agentId !== undefined && s.agentId === sp.agentId && s.t0 <= until)
  const runs = turn.runs.filter(r => r.agentId !== undefined && r.agentId === sp.agentId && r.t0 <= until)
  const done = sp.answer !== undefined && (sp.t1 ?? Infinity) <= until
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text color={C.sub} bold>{sp.type}</Text>
        <Text dimColor>{` · ${sp.model ?? "the parent's model"} · ${sp.agentId ?? 'starting'}`}</Text>
      </Text>
      {textBox(el, d, 'its prompt', `${fmt(sp.prompt.length)} chars`, sp.prompt, 4)}
      <Box flexDirection="column">
        <Text bold>its loop</Text>
        {steps.map(s => {
          const now = stepAt(s, d.at)
          return (
            <Text wrap="truncate-end">
              <Text color={C.sub}>{`step #${s.index}`}</Text>
              <Text dimColor>{` · ${s.messageCount} messages · cache ${k(now.usage?.cacheRead)} read / ${k(now.usage?.cacheWrite)} written · ${now.stop ?? 'in progress'}`}</Text>
            </Text>
          )
        })}
        {runs.map(r => {
          const running = r.t1 === undefined || r.t1 > until
          return (
            <Text wrap="truncate-end">
              <Text color={C.tool}>{'  ' + r.tool}</Text>
              <Text dimColor>{` ${r.decision ?? ''} · ${running ? 'running' : dur(r.t1! - r.t0)} · ${firstLine(running ? r.input : (r.result ?? r.input))}`}</Text>
            </Text>
          )
        })}
        {steps.length === 0 && <Text dimColor>it has not made its first request yet</Text>}
      </Box>
      {done && textBox(el, d, 'its report', 'comes back as an <agent-message>', sp.answer!, 6)}
    </Box>
  )
}

function rowsView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text } = el
  const rows = slice(d, ev.rows)
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>new rows</Text>
        <Text dimColor>{' · session.append · the next request carries all of them'}</Text>
      </Text>
      {rows.length === 0 && <Text dimColor>nothing yet</Text>}
      {rows.slice(-18).map(r => rowLine(el, r, true, true))}
    </Box>
  )
}

function answerView(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text } = el
  const turn = d.turn!
  const step = stepAt(turn.steps[ev.step ?? 0]!, d.at)
  const texts = step.chunks.filter(c => c.k === 'text')
  const replaying = d.at !== null && (turn.t1 === undefined || d.at < turn.t1)
  const answer = !replaying && turn.answer !== undefined ? turn.answer : texts.map(c => c.s).join('')
  const closing = slice(d, ev.rows)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          <Text bold>text chunks</Text>
          <Text dimColor>{` · ${texts.length}`}</Text>
        </Text>
        {texts.slice(-10).map(c => (
          <Text wrap="truncate-end">
            <Text dimColor>{pad((c.t / 1000).toFixed(3), 9)}</Text>
            {JSON.stringify(c.s)}
          </Text>
        ))}
      </Box>
      {textBox(el, d, 'answer', `${fmt(answer.length)} chars`, answer, 6)}
      {usageLine(el, step)}
      {closing.length > 0 && (
        <Box flexDirection="column">
          <Text bold>closing</Text>
          {closing.slice(-6).map(r => rowLine(el, r, true, false))}
        </Box>
      )}
    </Box>
  )
}

function header(el: El, d: PaneData, ev: LoopEvent): JSX.Element {
  const { Box, Text, Button } = el
  const turn = d.turn!
  const rounds = Math.max(1, turn.steps.filter(s => !s.agentId).length)
  const accent = ev.sub ? C.sub : C.model
  const follow = d.view.cursor === null && d.view.t === null
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text bold>x-ray · loop</Text>
          <Text dimColor>{`  turn #${turn.n} · round ${ev.round} of ${rounds}${ev.sub ? ' · inside the subagent' : ''}`}</Text>
        </Text>
        <Text color={turn.isOpen ? C.add : C.dim}>{`${turn.isOpen ? '● live' : '■ done'} ${secs(lastT(turn))}`}</Text>
      </Box>
      <Box flexWrap="wrap" columnGap={1}>
        {NODES.map((label, i) => {
          const on = ev.node === i + 1
          return (
            <Text inverse={on} bold={on} color={on ? accent : undefined} dimColor={!on}>
              {` ${i + 1} ${label} `}
            </Text>
          )
        })}
      </Box>
      <Box columnGap={1} flexWrap="wrap">
        <Button key="prev" hotkey="h" label="◂" onPress={d.act.prev} />
        <Button key="next" hotkey="l" label="▸" onPress={d.act.next} />
        <Button key="follow" hotkey="f" label={follow ? '● following' : '○ follow live'} onPress={d.act.follow} />
        <Text dimColor>{`${d.cursor + 1}/${d.events.length} · ${secs(ev.t)}`}</Text>
        <Text bold color={accent}>{ev.title}</Text>
      </Box>
    </Box>
  )
}

export function drawPane(el: El, d: PaneData): JSX.Element {
  const { Box, Text } = el
  const ev = d.events[d.cursor]
  if (!d.turn || !ev) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>x-ray · loop</Text>
        <Text dimColor>
          No turn recorded yet. Send a prompt and watch, live, how Claude Code builds the request, what the stream brings back and what each tool does.
        </Text>
      </Box>
    )
  }
  const BODY = { prompt: promptView, request: requestView, stream: streamView, check: checkView, tool: toolView, sub: subView, rows: rowsView, answer: answerView }
  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {header(el, d, ev)}
      {timelineView(el, d)}
      {BODY[ev.kind](el, d, ev)}
    </Box>
  )
}
