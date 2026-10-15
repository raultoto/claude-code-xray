import { describe, expect, test } from 'claude-code/testing'

import { buildEvents, buildSpans, eventAt } from '../hooks/loop'
import { Recorder } from '../hooks/recorder'
import { assemble, stepAt } from '../hooks/view'

const usage = { input_tokens: 2, output_tokens: 30, cache_read_input_tokens: 10591, cache_creation_input_tokens: 26012 }

function readTurn(): Recorder {
  const r = new Recorder()
  r.row('hook-context', { type: 'attachment', name: 'hook_success', content: [{ type: 'text', text: 'SessionStart ok' }] }, undefined, 900)
  r.begin('which version is package.json? mail me at dev@example.com', 1000)
  r.compose([
    { id: 'lean_body', scope: 'shared', text: 'You are an interactive agent…' },
    { id: 'memory', scope: 'session', text: '# Memory' },
  ], 1010)
  r.describe('Read', false)
  r.describe('Workflow', true)
  r.row('prompt', { type: 'user', role: 'user', content: [{ type: 'text', text: 'which version? dev@example.com' }] }, undefined, 1020)
  r.markRunning('', 1030)

  const s0 = r.stepStart({ index: 0, model: 'claude-opus-5-5', messageCount: 3 }, 1100)
  r.chunk(s0, { kind: 'thinking', index: 0, text: '' }, 1150)
  r.chunk(s0, { kind: 'tool', index: 1, name: 'Read' }, 1200)
  r.chunk(s0, { kind: 'input', index: 1, json: '{"file_path": "/' }, 1210)
  r.chunk(s0, { kind: 'input', index: 1, json: 'repo/package.json"}' }, 1220)
  r.callStart('toolu_1', 'Read', undefined, '{"file_path":"/repo/package.json"}', 1230)
  r.check('toolu_1', 'Read', undefined, 'allow', undefined, 1240)
  r.chunk(s0, { kind: 'stop', stopReason: 'tool_use', usage }, 1300)
  r.stepEnd(s0, { stopReason: 'tool_use', usage }, 1310)
  r.row('response', { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/package.json' } }] }, undefined, 1305)
  r.callEnd('toolu_1', { text: '{"version":"1.0.0"}' }, 1400)
  r.row('tool-result', { type: 'user', role: 'user', content: [{ type: 'tool_result', content: '{"version":"1.0.0"}' }] }, undefined, 1410)

  const s1 = r.stepStart({ index: 1, model: 'claude-opus-5-5', messageCount: 5 }, 1500)
  r.chunk(s1, { kind: 'text', index: 0, text: 'It is ' }, 1600)
  r.chunk(s1, { kind: 'text', index: 0, text: '1.0.0' }, 1601)
  r.chunk(s1, { kind: 'stop', stopReason: 'end_turn', usage }, 1610)
  r.stepEnd(s1, { stopReason: 'end_turn', usage }, 1620)
  r.finish('It is 1.0.0', 1700)
  return r
}

describe('the loop of one turn', () => {
  test('walks the seven steps in order, one round per request', async () => {
    const turn = readTurn().snapshot()!
    expect(buildEvents(turn).map(e => `${e.node}:${e.kind}`)).toEqual([
      '1:prompt', '2:request', '3:stream', '4:check', '5:tool', '6:rows', '2:request', '3:stream', '7:answer',
    ])
    expect(buildEvents(turn).map(e => e.round)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2])
  })

  test('assembles the tool_use from the JSON pieces as they arrived', async () => {
    const turn = readTurn().snapshot()!
    const blocks = assemble(turn.steps[0]!)
    expect(blocks.map(b => b.kind)).toEqual(['thinking', 'tool'])
    expect(blocks[1]!.name).toBe('Read')
    expect(blocks[1]!.text).toBe('{"file_path": "/repo/package.json"}')
    expect(blocks.every(b => b.closed)).toBe(true)
  })

  test('request #0 carries what came before the turn, round 2 only what is new', async () => {
    const turn = readTurn().snapshot()!
    const events = buildEvents(turn)
    const req0 = events.find(e => e.key === 'req0')!
    const req1 = events.find(e => e.key === 'req1')!
    expect(turn.rows.slice(...req0.rows!).map(r => r.door)).toEqual(['hook-context', 'prompt'])
    expect(turn.rows.slice(...req1.rows!).map(r => r.door)).toEqual(['response', 'tool-result'])
    expect(turn.steps[0]!.usage).toEqual({ input: 2, output: 30, cacheRead: 10591, cacheWrite: 26012 })
  })

  test('never keeps an email', async () => {
    const turn = readTurn().snapshot()!
    expect(turn.prompt).toContain('[email]')
    expect(JSON.stringify(turn)).not.toContain('dev@example.com')
  })

  test('the verdict and the result stay on the tool that ran', async () => {
    const turn = readTurn().snapshot()!
    expect(turn.runs[0]).toMatchObject({ tool: 'Read', decision: 'allow', result: '{"version":"1.0.0"}', resultChars: 19 })
  })

  test('the timeline has one span per request and per tool, each pointing at its step', async () => {
    const turn = readTurn().snapshot()!
    const events = buildEvents(turn)
    const spans = buildSpans(turn, events)
    expect(spans.map(s => `${s.depth}:${s.label}`)).toEqual(['0:builds the prompt', '0:step #0 → model', '1:Read', '0:step #1 → model'])
    expect(events[spans[2]!.event]!.kind).toBe('tool')
    expect(events[spans[3]!.event]!.kind).toBe('answer')
    expect(spans[1]).toMatchObject({ t0: 100, t1: 310, ttft: 50, kind: 'model' })
    expect(spans[2]).toMatchObject({ t0: 230, t1: 400, check: 240 })
  })

  test('moving the playhead picks the step that had started by then', async () => {
    const events = buildEvents(readTurn().snapshot()!)
    expect(events[eventAt(events, 0)]!.kind).toBe('prompt')
    expect(events[eventAt(events, 205)]!.kind).toBe('stream')
    expect(events[eventAt(events, 235)]!.kind).toBe('tool')
    expect(events[eventAt(events, 700)]!.kind).toBe('answer')
  })

  test('replay shows the half-arrived JSON and the block still open', async () => {
    const step = readTurn().snapshot()!.steps[0]!
    const blocks = assemble(stepAt(step, 210))
    expect(blocks[1]!.text).toBe('{"file_path": "/')
    expect(blocks[1]!.closed).toBe(false)
    expect(stepAt(step, 210).usage).toBeUndefined()
    expect(stepAt(step, null)).toBe(step)
  })

  test('a subagent adds its own steps inside the Agent tool', async () => {
    const r = new Recorder()
    r.begin('count the .mjs files', 0)
    r.markRunning('', 0)
    const s0 = r.stepStart({ index: 0, model: 'm', messageCount: 2 }, 10)
    r.chunk(s0, { kind: 'tool', index: 0, name: 'Agent' }, 20)
    r.callStart('toolu_a', 'Agent', undefined, '{"subagent_type":"Explore"}', 30)
    r.stepEnd(s0, { stopReason: 'tool_use' }, 40)
    r.spawn('toolu_a', 'Explore', 'm', undefined, 'Count .mjs files', 50)
    r.subStart('agent-1')
    const sub = r.stepStart({ agentId: 'agent-1', index: 0, model: 'm', messageCount: 11 }, 60)
    r.stepEnd(sub, { stopReason: 'end_turn' }, 70)
    r.subEnd('agent-1', 'There are 4', 80)
    r.callEnd('toolu_a', { text: 'report delivered' }, 90)
    const turn = r.snapshot()!
    const events = buildEvents(turn)
    expect(events.map(e => e.kind)).toContain('sub')
    expect(events.find(e => e.kind === 'sub')!.sub).toBe(true)
    expect(turn.spawns[0]).toMatchObject({ agentId: 'agent-1', answer: 'There are 4' })
    const spans = buildSpans(turn, events)
    expect(spans.map(s => `${s.depth}:${s.label}`)).toEqual(['0:builds the prompt', '0:step #0 → model', '1:Agent', '2:subagent Explore', '3:step #0 → model'])
    expect(spans.filter(s => s.inSub).every(s => events[s.event]!.kind === 'sub')).toBe(true)
  })
})
