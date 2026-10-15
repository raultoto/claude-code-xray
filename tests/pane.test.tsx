import { expect, test } from 'claude-code/testing'

const usage = { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, model: 'claude-opus-5-5' }

const PANE = {
  plugin: 'xray-loop',
  component: 'Pane',
  requestId: 'xray-loop',
  props: { title: 'x-ray · loop', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane follows the turn live and lets you walk every step and replay it', async ($, on) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    if (e.turnId === 'turn-1' && e.index === 0) {
      yield { kind: 'tool', index: 0, id: 'toolu_1', name: 'Read' }
      yield { kind: 'input', index: 0, json: '{"file_path": "/repo/' }
      yield { kind: 'input', index: 0, json: 'package.json"}' }
      yield { kind: 'stop', stopReason: 'tool_use', usage }
      return { turnId: e.turnId, index: 0, answer: '', toolUses: [{ name: 'Read', input: { file_path: '/repo/package.json' } }], stopReason: 'tool_use', usage }
    }
    yield { kind: 'text', index: 0, text: 'The version is 1.0.0.' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'The version is 1.0.0.', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: { type: 'text' }, text: '{"name":"repo","version":"1.0.0"}', isReadOnly: true }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.turn.start({ text: 'Which version is package.json?', turnId: 'turn-1' })
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })) {
    // drained
  }
  await $.tool.check({ tool: 'Read', input: { file_path: '/repo/package.json' }, tool_use_id: 'toolu_1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_1', file_path: '/repo/package.json' })
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 1, model: 'claude-opus-5-5', messageCount: 5 })) {
    // drained
  }
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', durationMs: 800, isAborted: false, answer: 'The version is 1.0.0.', usage })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Answers and closes the turn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /The version is 1\.0\.0\./ })).toBeDefined()

    for (let i = 0; i < 10; i += 1) await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /Builds the prompt/ })).toBeDefined()

    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /package\.json/ })).toBeDefined()

    await ui.press({ key: 'sp:run0' })
    expect(await ui.find({ type: 'Text', text: /Runs Read/ })).toBeDefined()

    await ui.press({ key: 'follow' })
    for (let i = 0; i < 6; i += 1) await ui.press({ key: 'tl-back' })
    expect(await ui.find({ type: 'Text', text: /replay: the turn as it stood/ })).toBeDefined()

    await ui.press({ key: 'follow' })
    expect(await ui.find({ type: 'Text', text: /replay/ })).toBeUndefined()

    await ui.press({ key: 'tl-toggle' })
    expect(await ui.find({ key: 'sp:run0' })).toBeUndefined()
    await ui.press({ key: 'tl-toggle' })
    expect(await ui.find({ key: 'sp:run0' })).toBeDefined()
    await ui.unmount()
  }
})

test('a new turn is followed live by default, even after exploring the last one', async ($, on) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: `answer of ${e.turnId}` }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: 0, answer: `answer of ${e.turnId}`, toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  const run = async (turnId: string) => {
    await $.turn.start({ text: 'hi', turnId })
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      // drained
    }
    await $.turn.complete({ turnId, reason: 'answer', durationMs: 10, isAborted: false, answer: `answer of ${turnId}`, usage })
  }

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await run('a')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'follow' }))?.props.label).toBe('● following')

  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect((await ui.find({ key: 'follow' }))?.props.label).toBe('○ follow live')

  await run('b')
  await ui.redraw()
  expect((await ui.find({ key: 'follow' }))?.props.label).toBe('● following')
  expect(await ui.find({ type: 'Text', text: /answer of b/ })).toBeDefined()
  await ui.unmount()
})
