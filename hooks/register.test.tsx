import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  agentLabel,
  blocksLit,
  cacheLabel,
  cacheTtl,
  compactionLabel,
  doneText,
  endedTasks,
  etaLabel,
  FEATURES,
  features,
  figure,
  hasRow,
  heat,
  isEnded,
  isStale,
  isPersonAsked,
  liveKinds,
  nudgeDue,
  overrun,
  parseEstimate,
  pausedFor,
  rowsOf,
  scene,
  strip,
  stripLit,
  waitingLabel,
  waitingText,
  workLabel,
  worthNotifying,
} from './register'

const BAND = {
  plugin: 'context-heat',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const BACKDROP = {
  plugin: 'context-heat',
  component: 'Backdrop',
  requestId: 'backdrop',
  surface: 'desktop',
  props: { scene: 'heat-blocks', plugin: 'context-heat', glass: false },
} as const

const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }] as never

const ALL_OFF = Object.fromEntries(Object.keys(FEATURES).map(name => [name, false]))

// The engine beneath the mod, answered from memory, with what the mod asked of it.
function world(on: On, agents: readonly unknown[] = [], isSpawnAnswered = true) {
  const seen = { commands: [] as string[], toasts: [] as string[], statuses: 0, notes: [] as string[], contexts: [] as string[][] }
  const reply: { answer: string; usage: unknown } = { answer: '', usage: null }
  const clock = mock.clock(on, { now: 1_000_000 })

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => e as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0 }, rateLimits: [] } }) as never)
  on('session.cwd', () => ({ value: '/Users/someone/Code/repo' }))
  on('agent.list', () => ({ value: agents }) as never)
  on('command.register', (_, e) => {
    seen.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => {
    seen.statuses += 1

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    seen.notes.push(e.text)

    return { value: { isSent: true, channel: 'terminal' } } as never
  })
  on('prompt.submit', (_, e) => {
    seen.contexts.push([...(e.context ?? [])])

    return { text: e.text }
  })
  on('session.compact', () => ({ messages: SUMMARY }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: reply.answer, toolUses: [], stopReason: 'end_turn', usage: reply.usage } as never
  })

  if (isSpawnAnswered) {
    on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  }

  return { seen, clock, reply }
}

type World = ReturnType<typeof world>

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/Users/someone/Code/repo', surface: 'desktop', isInteractive: true })
}

async function measure($: Engine, tokens: number): Promise<void> {
  await $.session.measure({ context: { tokens }, rateLimits: [], changed: [] } as never)
}

// One model request of the main loop (or an agent's) that answers `answer`.
async function step($: Engine, w: World, answer: string, agentId?: string, usage: unknown = null): Promise<void> {
  w.reply.answer = answer
  w.reply.usage = usage

  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId })) {
    // read to the end
  }
}

function done(turnId: string, agentId?: string) {
  return { turnId, agentId, answer: '', durationMs: 0, isAborted: false, reason: 'answer' } as never
}

test('blocks stack evenly to 600k and stop at 10,368', () => {
  expect(blocksLit(0)).toBe(0)
  expect(blocksLit(57)).toBe(0)
  expect(blocksLit(58)).toBe(1)
  expect(blocksLit(300_000)).toBe(5184)
  expect(blocksLit(600_000)).toBe(10368)
  expect(blocksLit(700_000)).toBe(10368)
})

test('the strip lights one dot for every 2.5k and names the figure', () => {
  expect(stripLit(120_000)).toBe(48)
  expect(stripLit(380_000)).toBe(152)
  expect(stripLit(610_000)).toBe(240)
  expect(figure(380_000)).toBe('380k of 600k')
  expect(figure(610_000)).toBe('610k: write the handoff')
  expect(strip(380_000).split('<circle').length - 1).toBe(240)
  expect(strip(380_000).split('opacity=".25"').length - 1).toBe(88)
})

test('past 600k the red deepens until 750k', () => {
  expect(overrun(600_000)).toBe(0)
  expect(overrun(675_000)).toBe(0.5)
  expect(overrun(900_000)).toBe(1)
  expect(heat(1, 1)).toBe('#7a1010')
  expect(scene(750_000).includes('#7a1010')).toBe(true)
  expect(strip(750_000).includes('#7a1010')).toBe(true)
  expect(strip(600_000).includes('#d62828')).toBe(true)
})

test('blocks warm from cool blue to red', () => {
  expect(heat(0)).toBe('#378add')
  expect(heat(1)).toBe('#d62828')
})

test('the scene pulses only from 600k', () => {
  expect(scene(599_999).includes('class="full"')).toBe(false)
  expect(scene(600_000).includes('class="full"')).toBe(true)
  expect(scene(300_000).split('fill="url(#r').length - 1).toBe(36)
  expect(scene(300_100).includes('width="10" height="10" fill="url(#r36)"')).toBe(true)
})

test('the work row names what is running', () => {
  expect(workLabel(false, 0)).toBe(null)
  expect(workLabel(true, 0)).toBe('Working: Claude is replying')
  expect(workLabel(false, 1)).toBe('Working: 1 agent running')
  expect(workLabel(true, 3)).toBe('Working: Claude is replying, 3 agents running')
  expect(workLabel(false, 0, ['shell'])).toBe('Working: 1 command running')
  expect(workLabel(false, 1, ['shell', 'shell', 'workflow', 'subagent'])).toBe(
    'Working: 1 agent running, 2 commands running, 1 workflow running',
  )
  expect(workLabel(false, 0, ['subagent'])).toBe(null)
  expect(workLabel(false, 0, ['remote'])).toBe('Working: 1 background task running')
})

test('an estimate is read from a reply, never from a report of finished work', () => {
  expect(parseEstimate('On it. Estimate 25 min; I will push it when it passes.')).toBe(25)
  expect(parseEstimate('Estimate: 15 minutes.')).toBe(15)
  expect(parseEstimate('Built (estimate 15 min, actual 2): the row counts down.')).toBe(null)
  expect(parseEstimate('Estimate: 10 minutes')).toBe(10)
  expect(parseEstimate('On it.\n\nEstimate: 25 min.')).toBe(25)
  expect(parseEstimate('**Estimate:** about 5 minutes')).toBe(5)
  expect(parseEstimate('Built (estimate 5 min, actual 3).')).toBe(null)
  expect(parseEstimate('Live on uat. Estimate 35, actual 42.')).toBe(null)
  expect(parseEstimate('Estimate: 0 minutes')).toBe(null)
})

test('the countdown counts down, then counts the overrun', () => {
  expect(etaLabel(10, 0, 0)).toEqual({ text: '10:00 left of 10 min', isOver: false })
  expect(etaLabel(10, 0, 200_000)).toEqual({ text: '6:40 left of 10 min', isOver: false })
  expect(etaLabel(10, 0, 600_000)).toEqual({ text: '0:00 left of 10 min', isOver: false })
  expect(etaLabel(10, 0, 792_000)).toEqual({ text: '3:12 over the 10 min estimate', isOver: true })
})

test('a task notification names the tasks that ended', () => {
  const done = '<task-notification>\n<task-id>b4q69mqkt</task-id>\n<status>completed</status>\n</task-notification>'
  const going = '<task-notification>\n<task-id>abc</task-id>\n<status>running</status>\n</task-notification>'

  expect(endedTasks(done)).toEqual(['b4q69mqkt'])
  expect(endedTasks(going)).toEqual([])
  expect(endedTasks(done + going + done.replace('b4q69mqkt', 'zzz').replace('completed', 'failed'))).toEqual(['b4q69mqkt', 'zzz'])
  expect(endedTasks('no notification here')).toEqual([])
})

test('held background tasks count until they go stale', () => {
  const held = [
    { id: 'a', kind: 'shell', at: 0 },
    { id: 'b', kind: 'workflow', at: 1000 },
  ]

  expect(liveKinds(held, 2000)).toEqual(['shell', 'workflow'])
  expect(liveKinds(held, 12 * 60 * 60 * 1000 + 500)).toEqual(['workflow'])
})

test('time asleep or closed is not counted', () => {
  expect(pausedFor(0, 999_999)).toBe(0)
  expect(pausedFor(100_000, 101_000)).toBe(0)
  expect(pausedFor(100_000, 119_000)).toBe(0)
  expect(pausedFor(100_000, 100_000 + 37_000_000)).toBe(36_999_000)
})

test('the row says idle with nothing running', async $ => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Idle/ }))?.text).toBe('Idle: nothing running')
  await ui.unmount()
})

// Switches

test('every feature is on by default, and a setting or FEATURES turns one off', () => {
  const all = features({})

  expect(Object.values(all).every(Boolean)).toBe(true)
  expect(features({ cacheTimer: false }).cacheTimer).toBe(false)
  expect(features({ cacheTimer: false }).compactionCount).toBe(true)
  expect(hasRow(features(ALL_OFF))).toBe(false)
})

test('agentList and backgroundTasks need workStatus; estimateNote needs countdown or notifications', () => {
  expect(features({ workStatus: false }).agentList).toBe(false)
  expect(features({ workStatus: false }).backgroundTasks).toBe(false)
  expect(features({ countdown: false }).estimateNote).toBe(true)
  expect(features({ countdown: false, notifications: false }).estimateNote).toBe(false)
})

test('backdrop on: the blocks are drawn', async $ => {
  const ui = await $.ui.mount(BACKDROP)

  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})

// The test engine has no $.theme, so a call to $.theme.set would fail the start hook before it
// registers /handoff: the command being there shows the theme was never set.
test('backdrop off: no theme is set and no blocks are drawn', { options: { backdrop: false } }, async ($, on) => {
  const { seen } = world(on)
  on('ui.render', ($$, e) => {
    const { Box } = $$.ui.resolve(e)

    return <Box />
  })
  await start($)
  const ui = await $.ui.mount(BACKDROP)

  expect(seen.commands).toEqual(['handoff'])
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('dots off: the row draws no strip', { options: { dots: false } }, async $ => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /of 600k/ })).toBeDefined()
  await ui.unmount()
})

test('contextFigure off: no figure on the row', { options: { contextFigure: false } }, async $ => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /of 600k/ })).toBeUndefined()
  await ui.unmount()
})

test('workStatus off: no Working or Idle words', { options: { workStatus: false } }, async $ => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeUndefined()
  await ui.unmount()
})

test('every row feature off: the mod draws no row', { options: ALL_OFF }, async ($, on) => {
  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Idle|of 600k/ })).toBeUndefined()
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('backgroundTasks off: a background command is not counted', { options: { backgroundTasks: false } }, async ($, on) => {
  on('tool.call', () => ({ result: { backgroundTaskId: 'b1' } }) as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeDefined()
  await ui.unmount()
})

test('backgroundTasks on: a background command reads as work', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { backgroundTaskId: 'b1' } }) as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'Working: 1 command running' })).toBeDefined()
  await ui.unmount()
})

test('countdown on: a stated estimate counts down on the row', async ($, on) => {
  const w = world(on)
  await step($, w, 'Estimate: 10 minutes')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /left of 10 min/ })).toBeDefined()
  await ui.unmount()
})

test('countdown off: no countdown on the row', { options: { countdown: false } }, async ($, on) => {
  const w = world(on)
  await step($, w, 'Estimate: 10 minutes')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /left of/ })).toBeUndefined()
  await ui.unmount()
})

test('estimateNote on: the note rides on a prompt', async ($, on) => {
  const { seen } = world(on)
  await $.prompt.submit({ text: 'fix it' } as never)

  expect(seen.contexts[0]?.some(note => note.includes('Estimate: N minutes'))).toBe(true)
})

test('estimateNote off: nothing is added to a prompt', { options: { estimateNote: false } }, async ($, on) => {
  const { seen } = world(on)
  await $.prompt.submit({ text: 'fix it' } as never)

  expect(seen.contexts).toEqual([[]])
})

test('handoffWarning off: no status line, plain figure, no pulse', { options: { handoffWarning: false } }, async ($, on) => {
  const { seen } = world(on)
  await measure($, 610_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(seen.statuses).toBe(0)
  expect(await ui.find({ type: 'Text', text: '610k of 600k' })).toBeDefined()
  expect(scene(610_000, false).includes('class="full"')).toBe(false)
  await ui.unmount()
})

test('handoffWarning on: the status line and the warning figure', async ($, on) => {
  const { seen } = world(on)
  await measure($, 610_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(seen.statuses).toBe(1)
  expect(await ui.find({ type: 'Text', text: '610k: write the handoff' })).toBeDefined()
  await ui.unmount()
})

test('redPastLimit off: nothing deepens past 600k', () => {
  expect(overrun(750_000, false)).toBe(0)
  expect(strip(750_000, false).includes('#7a1010')).toBe(false)
  expect(scene(750_000, true, false).includes('#7a1010')).toBe(false)
})

// 585k nudge

test('the 585k nudge is due once only', () => {
  expect(nudgeDue(584_999, false)).toBe(false)
  expect(nudgeDue(585_000, false)).toBe(true)
  expect(nudgeDue(700_000, true)).toBe(false)
})

test('handoffNudge on: one notice at 585k and the /handoff command', { options: { backdrop: false } }, async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await measure($, 586_000)
  await measure($, 590_000)
  await measure($, 620_000)

  expect(seen.toasts).toEqual(['585k: run /handoff, then open a new session'])
  expect(seen.commands).toEqual(['handoff'])

  const ran = await $.command.run({ command: 'handoff' } as never)
  await clock.settle()
  expect(ran.text).toBe('Asking Claude to update the handoff.')
  expect(seen.contexts.length).toBe(1)
})

test('handoffNudge off: no notice and no command', { options: { handoffNudge: false, backdrop: false } }, async ($, on) => {
  const { seen } = world(on)
  await start($)
  await measure($, 590_000)

  expect(seen.toasts).toEqual([])
  expect(seen.commands).toEqual([])
})

// Cache timer

test('the cache line reads warm, counts down to cold, then cold', () => {
  const last = { at: 0, ttlMinutes: 5 }

  expect(cacheLabel(true, last, 999_999)).toEqual({ text: 'Cache warm', isWarning: false })
  expect(cacheLabel(false, last, 0)).toEqual({ text: 'Cache cold in 5:00', isWarning: false })
  expect(cacheLabel(false, last, 62_000)).toEqual({ text: 'Cache cold in 3:58', isWarning: false })
  expect(cacheLabel(false, last, 250_000)).toEqual({ text: 'Cache cold in 0:50', isWarning: true })
  expect(cacheLabel(false, last, 300_000)).toEqual({ text: 'Cache cold', isWarning: false })
  expect(cacheLabel(false, null, 0)).toBe(null)
})

test('the cache lifetime comes from the reply, else the constant', () => {
  expect(cacheTtl({ cache_creation_input_tokens: 10, ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 })).toBe(60)
  expect(cacheTtl({ cache_creation_input_tokens: 10, ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 })).toBe(5)
  expect(cacheTtl({ cache_read_input_tokens: 10 })).toBe(60)
  expect(cacheTtl({ cache_read_input_tokens: 10 }, 5)).toBe(5)
  expect(cacheTtl({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(null)
})

test('cacheTimer off: no cache line after a request', { options: { cacheTimer: false } }, async ($, on) => {
  const w = world(on)
  await step($, w, '', undefined, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, model: 'm' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
  await ui.unmount()
})

test('cacheTimer on: a cache line after a request', async ($, on) => {
  const w = world(on)
  await step($, w, '', undefined, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, model: 'm' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Cache cold/ })).toBeDefined()
  await ui.unmount()
})

// Compaction count

test('the compaction count reads in plain words and hides at zero', () => {
  expect(compactionLabel(0)).toBe(null)
  expect(compactionLabel(1)).toBe('Compacted 1 time')
  expect(compactionLabel(3)).toBe('Compacted 3 times')
})

test('compactionCount on: a compaction is counted, a precompute is not', async ($, on) => {
  world(on)
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'Compacted 1 time' })).toBeDefined()
  await ui.unmount()
})

test('compactionCount off: nothing is counted', { options: { compactionCount: false } }, async ($, on) => {
  world(on)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Compacted/ })).toBeUndefined()
  await ui.unmount()
})

// Waiting on you

test('the waiting line names what is open and for how long', () => {
  expect(waitingLabel('question', 0, 6 * 60_000 + 5_000)).toBe('Waiting on you: a question is open, 6 min')
  expect(waitingLabel('permission', 0, 20_000)).toBe('Waiting on you: a permission is open, 1 min')
})

test('a wait ends by its own call or its own loop, and two waits stay apart', () => {
  const question = { kind: 'question', since: 0, id: 'q1', loop: null } as const
  const permission = { kind: 'permission', since: 0, id: 'p1', loop: 'a1' } as const

  expect(isEnded(question, { id: 'p1' })).toBe(false)
  expect(isEnded(permission, { id: 'p1' })).toBe(true)
  expect(isEnded(question, { loop: null })).toBe(true)
  expect(isEnded(permission, { loop: null })).toBe(false)
  expect(isEnded(permission, {})).toBe(true)
})

test('only an ask a person answers counts as waiting', () => {
  expect(isPersonAsked('ask', 'person', undefined, 'default')).toBe(true)
  expect(isPersonAsked('ask', 'person', undefined, 'auto')).toBe(false)
  expect(isPersonAsked('ask', 'person', 'cc-plugin-sec-default', 'auto')).toBe(true)
  expect(isPersonAsked('ask', 'host', undefined, 'default')).toBe(false)
  expect(isPersonAsked('allow', 'person', undefined, 'default')).toBe(false)
})

test('waitingOnYou on: the row turns amber while a question is open', async ($, on) => {
  world(on)
  let text: string | undefined

  on('tool.call', async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    text = (await ui.find({ type: 'Text', text: /Waiting on you/ }))?.text
    await ui.unmount()

    return { result: { answers: {} } } as never
  })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)

  expect(text).toBe('Waiting on you: a question is open, 1 min')
})

test('waitingOnYou off: the row does not change while a question is open', { options: { waitingOnYou: false, notifications: false } }, async ($, on) => {
  world(on)
  let text: string | undefined = 'unset'

  on('tool.call', async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    text = (await ui.find({ type: 'Text', text: /Waiting on you/ }))?.text
    await ui.unmount()

    return { result: { answers: {} } } as never
  })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)

  expect(text).toBeUndefined()
})

// Notifications

test('the notification text, with the estimate when one ran', () => {
  expect(doneText('repo', null, 0)).toBe('repo: done')
  expect(doneText('repo', { minutes: 25, startedAt: 0 }, 22 * 60_000)).toBe('repo: done, estimate 25, actual 22')
  expect(waitingText('repo')).toBe('repo: waiting on you')
})

test('work under 30 seconds raises no notification', () => {
  expect(worthNotifying(null, 100_000)).toBe(false)
  expect(worthNotifying(0, 29_999)).toBe(false)
  expect(worthNotifying(0, 30_000)).toBe(true)
})

test('notifications on: a long turn ends with "done", a short one with nothing', async ($, on) => {
  const { seen, clock } = world(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10_000)
  await $.turn.complete(done('t1'))
  expect(seen.notes).toEqual([])

  await $.turn.start({ text: 'go', turnId: 't2' })
  await clock.advance(45_000)
  await $.turn.complete(done('t2'))
  expect(seen.notes).toEqual(['repo: done'])
})

test('notifications off: no notification at all', { options: { notifications: false } }, async ($, on) => {
  const { seen, clock } = world(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(45_000)
  await $.turn.complete(done('t1'))
  expect(seen.notes).toEqual([])
})

// Agent list

test('each agent counts down from its own estimate, or says how long it has run', () => {
  expect(agentLabel({ minutes: 12, at: 0 }, 0, 138_000)).toEqual({ text: '9:42 left of 12 min', isOver: false })
  expect(agentLabel({ minutes: 15, at: 0 }, 0, 1_085_000)).toEqual({ text: '3:05 over 15 min', isOver: true })
  expect(agentLabel(undefined, 0, 252_000)).toEqual({ text: 'running 4:12', isOver: false })
})

test('agentList on: each agent is asked for an estimate', async ($, on) => {
  world(on, [], false)
  let prompt = ''

  on('agent.spawn', (_, e) => {
    prompt = e.prompt

    return { model: 'm', agentId: 'a1' }
  })
  await $.agent.spawn({ prompt: 'do it', description: 'job', subagentType: 'general-purpose' } as never)

  expect(prompt.includes('Estimate: N minutes')).toBe(true)
})

test('agentList off: agents get their prompt as written', { options: { agentList: false } }, async ($, on) => {
  world(on, [], false)
  let prompt = ''

  on('agent.spawn', (_, e) => {
    prompt = e.prompt

    return { model: 'm', agentId: 'a1' }
  })
  await $.agent.spawn({ prompt: 'do it', description: 'job', subagentType: 'general-purpose' } as never)

  expect(prompt).toBe('do it')
})

test('agentList on: "N agents running" opens a list of the agents', async ($, on) => {
  const w = world(on, [{ id: 'a1', description: 'Review the diff', status: 'running', startTime: 1_000_000 }])
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await step($, w, 'Estimate: 12 minutes', 'a1')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'Review the diff' })).toBeUndefined()
  await ui.press({ key: 'agents' })
  expect(await ui.find({ type: 'Text', text: 'Review the diff' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /left of 12 min/ })).toBeDefined()
  await ui.unmount()
})

test('agentList off: the agent count is plain text with no list', { options: { agentList: false } }, async ($, on) => {
  world(on, [{ id: 'a1', description: 'Review the diff', status: 'running', startTime: 1_000_000 }])
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('sleepFix off: a gap in the ticks is counted as time', () => {
  expect(features({ sleepFix: false }).sleepFix).toBe(false)
  expect(pausedFor(100_000, 100_000 + 37_000_000, false)).toBe(0)
})

test('a countdown far past its estimate is dropped as stale', () => {
  const hour = { minutes: 60, startedAt: 0 }

  expect(isStale(hour, 60 * 60_000 + 4 * 3_600_000)).toBe(false)
  expect(isStale(hour, 60 * 60_000 + 4 * 3_600_000 + 1000)).toBe(true)
  expect(isStale(hour, 688 * 60_000 + 60 * 60_000)).toBe(true)

  const long = { minutes: 120, startedAt: 0 }

  expect(isStale(long, 120 * 60_000 + 5 * 3_600_000)).toBe(false)
  expect(isStale(long, 120 * 60_000 + 6 * 3_600_000 + 1000)).toBe(true)
})

test('the cache line sits on its own line with an icon, and joins the head line when rows run short', async ($, on) => {
  const w = world(on)
  await step($, w, '', undefined, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, model: 'm' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Cache cold in/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
  await ui.unmount()

  const short = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, maxRows: 2 } })

  expect(await short.find({ type: 'Text', text: /Cache cold in/ })).toBeDefined()
  await short.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await terminal.find({ type: 'Text', text: /Cache cold in/ })).toBeDefined()
  await terminal.unmount()
})

test('the row counts its own lines', () => {
  expect(rowsOf(true, true, 0)).toBe(3)
  expect(rowsOf(true, true, 2)).toBe(5)
  expect(rowsOf(false, false, 0)).toBe(1)
})
