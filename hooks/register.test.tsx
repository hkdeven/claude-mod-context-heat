import { expect, test } from 'claude-code/testing'

import { blocksLit, etaLabel, figure, heat, overrun, parseEstimate, scene, strip, stripLit, workLabel } from './register'

const BAND = {
  plugin: 'context-heat',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

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

test('the row says idle with nothing running', async $ => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Idle/ }))?.text).toBe('Idle: nothing running')
  await ui.unmount()
})
