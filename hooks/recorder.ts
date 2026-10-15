// Builds the record of the turn in flight from the engine's events. Pure: no `$`,
// every method takes the event's data and the time it happened (epoch ms).

import type { Chunk, ChunkKind, Row, Section, Spawn, Step, ToolInfo, ToolRun, TurnRec, Usage } from '../types'
import { clip, redact } from './redact'

const MAX_TEXT = 4000
const MAX_SECTION = 8000
const MAX_CHUNKS = 600
const MAX_ROWS = 500

export type ChunkIn = {
  kind: string
  index?: number
  text?: string
  json?: string
  name?: string
  stopReason?: string | null
  usage?: unknown
}

export type StepIn = { agentId?: string; index: number; model: string; messageCount: number }

export type MessageIn = { type?: string; name?: string; role?: string; content?: unknown }

export type CallResultIn = { text?: string; result?: unknown; isError?: boolean; deny?: string }

export function usageOf(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const n = (a: string, b: string) => Number(u[a] ?? u[b] ?? 0) || 0
  return {
    input: n('input_tokens', 'inputTokens'),
    output: n('output_tokens', 'outputTokens'),
    cacheRead: n('cache_read_input_tokens', 'cacheReadInputTokens'),
    cacheWrite: n('cache_creation_input_tokens', 'cacheCreationInputTokens'),
  }
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = (block ?? {}) as Record<string, unknown>
      if (b.type === 'text') return String(b.text ?? '')
      if (b.type === 'tool_use') return `[tool_use ${String(b.name)}] ${JSON.stringify(b.input ?? {})}`
      if (b.type === 'tool_result') return `[tool_result] ${textOf(b.content)}`
      if (b.type === 'thinking' || b.type === 'redacted_thinking') return '[thinking]'
      return `[${String(b.type)}]`
    })
    .join('\n')
}

const KINDS: readonly string[] = ['thinking', 'tool', 'input', 'text', 'stop']

export class Recorder {
  turn: TurnRec | null = null
  private startedAt = 0
  private n = 0
  private running = false
  private sections: Section[] = []
  private tools = new Map<string, ToolInfo>()
  private pending: Row[] = []
  private total = { rows: 0, chars: 0 }

  get isRunning(): boolean {
    return this.running
  }

  get turnNumber(): number {
    return this.n
  }

  begin(prompt: string, now: number): void {
    this.n += 1
    this.startedAt = now
    const adopted = this.pending
    this.pending = []
    const adoptedChars = adopted.reduce((sum, row) => sum + row.chars, 0)
    this.turn = {
      n: this.n,
      prompt: clip(redact(prompt), MAX_TEXT),
      isOpen: true,
      sections: this.sections,
      sectionsReused: this.sections.length > 0,
      tools: [],
      before: { rows: this.total.rows - adopted.length, chars: this.total.chars - adoptedChars },
      rows: adopted,
      steps: [],
      runs: [],
      spawns: [],
    }
  }

  markRunning(prompt: string, now: number): void {
    if (!this.turn || !this.turn.isOpen) this.begin(prompt, now)
    this.running = true
  }

  finish(answer: string, now: number): void {
    this.running = false
    if (!this.turn) return
    this.turn.isOpen = false
    this.turn.t1 = this.at(now)
    this.turn.answer = clip(redact(answer), MAX_TEXT)
  }

  compose(sections: readonly { id: string; text: string; scope: string }[], now: number): void {
    this.sections = sections.map(s => ({
      id: s.id,
      scope: s.scope === 'shared' ? 'shared' : 'session',
      chars: s.text.length,
      text: clip(redact(s.text), MAX_SECTION),
    }))
    if (this.turn?.isOpen) {
      this.turn.sections = this.sections
      this.turn.sectionsReused = false
      this.turn.sectionsAt = this.at(now)
    }
  }

  describe(tool: string, deferred: boolean): void {
    this.tools.set(tool, { name: tool, deferred })
  }

  row(door: string, message: MessageIn, agentId: string | undefined, now: number): void {
    const text = textOf(message.content)
    const row: Row = {
      t: 0,
      door,
      name: message.name ?? (door === 'response' ? 'assistant' : (message.role ?? message.type ?? door)),
      agentId,
      chars: text.length,
      text: clip(redact(text.replace(/^<system-reminder>\n?/, '').replace(/\n?<\/system-reminder>\s*$/, '')), MAX_TEXT),
    }
    this.total.rows += 1
    this.total.chars += row.chars
    if (this.turn?.isOpen) {
      row.t = this.at(now)
      if (this.turn.rows.length < MAX_ROWS) this.turn.rows.push(row)
    } else {
      this.pending.push(row)
      if (this.pending.length > MAX_ROWS) this.pending.shift()
    }
  }

  stepStart(e: StepIn, now: number): Step {
    if (!this.turn) this.begin('', now)
    const step: Step = {
      agentId: e.agentId,
      index: e.index,
      model: e.model,
      messageCount: e.messageCount,
      t0: this.at(now),
      chunks: [],
      dropped: 0,
    }
    this.turn!.steps.push(step)
    return step
  }

  chunk(step: Step, c: ChunkIn, now: number): void {
    if (!KINDS.includes(c.kind)) return
    const k = c.kind as ChunkKind
    if (k === 'stop') {
      step.stop = c.stopReason ?? undefined
      step.usage = usageOf(c.usage) ?? step.usage
    }
    const s = k === 'input' ? (c.json ?? '') : k === 'tool' ? (c.name ?? '') : k === 'stop' ? (c.stopReason ?? '') : (c.text ?? '')
    const chunk: Chunk = { t: this.at(now), k, i: c.index ?? 0, s: k === 'tool' || k === 'stop' ? s : redact(s) }
    if (step.chunks.length < MAX_CHUNKS) {
      step.chunks.push(chunk)
      return
    }
    const last = step.chunks[step.chunks.length - 1]
    if (last && last.k === chunk.k && last.i === chunk.i && (k === 'input' || k === 'text')) last.s += chunk.s
    else step.dropped += 1
  }

  stepEnd(step: Step, result: { stopReason?: string | null; usage?: unknown } | undefined, now: number): void {
    step.t1 = this.at(now)
    if (result?.stopReason) step.stop = result.stopReason
    step.usage = usageOf(result?.usage) ?? step.usage
  }

  callStart(id: string, tool: string, agentId: string | undefined, input: string, now: number): void {
    if (!this.turn) return
    this.turn.runs.push({ id, tool, agentId, input: clip(redact(input), MAX_TEXT), t0: this.at(now) })
  }

  callEnd(id: string, r: CallResultIn, now: number): void {
    const run = this.run(id)
    if (!run) return
    const text = r.deny !== undefined ? `deny: ${r.deny}` : (r.text ?? (r.result === undefined ? '' : JSON.stringify(r.result)))
    run.t1 = this.at(now)
    run.result = clip(redact(text), MAX_TEXT)
    run.resultChars = text.length
    run.isError = r.isError === true || r.deny !== undefined
  }

  check(id: string | undefined, tool: string, agentId: string | undefined, decision: string, reason: string | undefined, now: number): void {
    const runs = this.turn?.runs ?? []
    const run = (id ? this.run(id) : undefined) ??
      [...runs].reverse().find(r => r.tool === tool && r.agentId === agentId && r.decision === undefined)
    if (!run) return
    run.decision = decision
    run.reason = reason === undefined ? undefined : redact(reason)
    run.tCheck = this.at(now)
  }

  spawn(toolUseId: string, type: string, model: string | undefined, agentId: string | undefined, prompt: string, now: number): void {
    if (!this.turn) return
    const sp: Spawn = { toolUseId, type, model, agentId, prompt: clip(redact(prompt), MAX_TEXT), t: this.at(now) }
    this.turn.spawns.push(sp)
  }

  subStart(agentId: string): void {
    const spawns = this.turn?.spawns ?? []
    if (spawns.some(s => s.agentId === agentId)) return
    const open = [...spawns].reverse().find(s => s.agentId === undefined)
    if (open) open.agentId = agentId
  }

  subEnd(agentId: string, answer: string, now: number): void {
    const sp = this.turn?.spawns.find(s => s.agentId === agentId)
    if (!sp) return
    sp.t1 = this.at(now)
    sp.answer = clip(redact(answer), MAX_TEXT)
  }

  snapshot(): TurnRec | null {
    if (!this.turn) return null
    const copy = JSON.parse(JSON.stringify(this.turn)) as TurnRec
    copy.tools = [...this.tools.values()]
    return copy
  }

  private run(id: string): ToolRun | undefined {
    return this.turn?.runs.find(r => r.id === id)
  }

  private at(now: number): number {
    return Math.max(0, now - this.startedAt)
  }
}
