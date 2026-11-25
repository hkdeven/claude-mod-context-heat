import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeatEta } from '../types'

const SCENE = 'heat-blocks'
const LIMIT = 600_000
const COLS = 144
const ROWS = 72
const STRIP_COLS = 120
const STRIP = STRIP_COLS * 2
const OVER = 150_000
const DEEP = [122, 16, 16] as const
const BLOCKS = COLS * ROWS
const HANDOFF = '600k: write the handoff'

const tokens = atom({ plugin: 'context-heat', key: 'tokens' } as const, 0)
const agents = atom({ plugin: 'context-heat', key: 'agents' } as const, 0)
const eta = atom({ plugin: 'context-heat', key: 'eta' } as const, null)
const clock = atom({ plugin: 'context-heat', key: 'clock' } as const, 0)

const ESTIMATE_RULE =
  'Before starting any piece of work that edits files or runs commands, state one total time estimate ' +
  'on a line of its own, in exactly this form: "Estimate: N minutes", N a whole number. State it once ' +
  'for each piece of work, before the first tool call, and again only when a new piece of work begins. ' +
  'A plain answer that needs no work gets no estimate.'

let timer: { cancel: () => void } | null = null
let isMainRunning = false

const STOPS = [
  [55, 138, 221],
  [29, 158, 117],
  [242, 192, 55],
  [239, 122, 39],
  [214, 40, 40],
] as const

// How far past 600k the session is, 0 at the limit to 1 at 750k.
export function overrun(count: number): number {
  return Math.max(0, Math.min(1, (count - LIMIT) / OVER))
}

// Cool blue for the first block, through green, yellow and orange, to red for the last.
// Past 600k every block deepens toward dark red, the warm ones most.
export function heat(fraction: number, over = 0): string {
  const f = Math.max(0, Math.min(1, fraction))
  const x = f * (STOPS.length - 1)
  const a = Math.min(STOPS.length - 2, Math.floor(x))
  const p = x - a
  const from = STOPS[a]!
  const to = STOPS[a + 1]!
  const deep = over * Math.max(0.35, f)

  return (
    '#' +
    [0, 1, 2]
      .map(i => {
        const base = from[i]! + (to[i]! - from[i]!) * p

        return Math.round(base + (DEEP[i]! - base) * deep).toString(16).padStart(2, '0')
      })
      .join('')
  )
}

export function blocksLit(count: number): number {
  return Math.max(0, Math.min(BLOCKS, Math.floor((count * BLOCKS) / LIMIT)))
}

// Small blocks stacked from the bottom row, left to right; each row one step warmer.
export function scene(count: number): string {
  const lit = blocksLit(count)
  const isFull = count >= LIMIT
  const over = overrun(count)
  const rows = Math.ceil(lit / COLS)
  const block = (fill: string) => `<rect x=".5" y=".5" width="9" height="9" rx="1" fill="${fill}"`
  let patterns = ''
  let rects = ''

  for (let row = 0; row < rows; row++) {
    const blocks = Math.min(COLS, lit - row * COLS)
    const y = (ROWS - 1 - row) * 10
    patterns +=
      `<pattern id="r${row}" width="10" height="10" patternUnits="userSpaceOnUse">` +
      `${block(heat(row / (ROWS - 1), over))}/></pattern>`
    rects += `<rect x="0" y="${y}" width="${blocks * 10}" height="10" fill="url(#r${row})"/>`
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLS * 10} ${ROWS * 10}" preserveAspectRatio="none">` +
    '<style>@keyframes glow{0%,100%{opacity:.06}50%{opacity:.14}}.full{animation:glow 3.2s ease-in-out infinite}</style>' +
    '<defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">' +
    `${block('#888888')} opacity=".04"/></pattern>${patterns}</defs>` +
    `<rect width="${COLS * 10}" height="${ROWS * 10}" fill="url(#grid)"/>` +
    `<g opacity=".07"${isFull ? ' class="full"' : ''}>${rects}</g>` +
    '</svg>'
  )
}

export function stripLit(count: number): number {
  return Math.max(0, Math.min(STRIP, Math.floor((count * STRIP) / LIMIT)))
}

// This session's own level: two rows of 120 dots across the full row, one dot for every 2.5k, filled column by column.
export function strip(count: number): string {
  const lit = stripLit(count)
  const over = overrun(count)
  let dots = ''

  for (let i = 0; i < STRIP; i++) {
    const col = Math.floor(i / 2)
    const cx = col * 5 + 2.5
    const cy = (1 - (i % 2)) * 5.5 + 2.75
    const fill = i < lit ? heat(col / (STRIP_COLS - 1), over) : '#888888'
    dots += `<circle cx="${cx}" cy="${cy}" r="1.7" fill="${fill}"${i < lit ? '' : ' opacity=".25"'}/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STRIP_COLS * 5} 11" width="${STRIP_COLS * 20}" height="44">${dots}</svg>`
}

export function figure(count: number): string {
  const thousands = Math.round(count / 1000)

  return count >= LIMIT ? `${thousands}k: write the handoff` : `${thousands}k of 600k`
}

export function workLabel(isReplying: boolean, running: number): string | null {
  const parts: string[] = []

  if (isReplying) {
    parts.push('Claude is replying')
  }

  if (running > 0) {
    parts.push(`${running} ${running === 1 ? 'agent' : 'agents'} running`)
  }

  return parts.length === 0 ? null : `Working: ${parts.join(', ')}`
}

// The minutes in "Estimate: 10 minutes" or "On it. Estimate 25 min"; null where a reply states none.
// A report of work already done ("estimate 5 min, actual 3") is not a new estimate.
export function parseEstimate(text: string): number | null {
  const found = /\bestimate[: \t*_]+(?:about[ \t]+|~)?(\d{1,3})[ \t]*min(?:ute)?s?\b(?![^.\n]*\bactual\b)/i.exec(text)
  const minutes = found === null ? 0 : Number(found[1])

  return minutes > 0 ? minutes : null
}

// "6:40 left of 10 min", or "3:12 over the 10 min estimate" once it has run past.
export function etaLabel(minutes: number, startedAt: number, now: number): { text: string; isOver: boolean } {
  const left = minutes * 60 - Math.max(0, Math.floor((now - startedAt) / 1000))
  const seconds = Math.abs(left)
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return left >= 0
    ? { text: `${time} left of ${minutes} min`, isOver: false }
    : { text: `${time} over the ${minutes} min estimate`, isOver: true }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, clock, () => now)
}

function startTimer($: EngineInterface): void {
  if (timer === null) {
    timer = $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
    })
  }
}

async function startEta($: EngineInterface, minutes: number): Promise<void> {
  const startedAt = await $.clock.now()
  await update($, clock, () => startedAt)
  const started: HeatEta = { minutes, startedAt }
  await update($, eta, () => started)
  startTimer($)
}

// The countdown ends when the main turn is over and no agent is still running.
async function settle($: EngineInterface): Promise<void> {
  if (isMainRunning || (await read($, agents)) > 0) {
    return
  }

  timer?.cancel()
  timer = null

  if ((await read($, eta)) !== null) {
    await update($, eta, () => null)
  }
}

async function countAgents($: EngineInterface): Promise<void> {
  const list = await $.agent.list()
  const running = list.filter(
    agent => agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting',
  ).length

  if (running !== (await read($, agents))) {
    await update($, agents, () => running)
  }
}

async function setTokens($: EngineInterface, count: number | undefined): Promise<void> {
  if (count === undefined) {
    return
  }

  if (count !== (await read($, tokens))) {
    await update($, tokens, () => count)
  }

  $.ui.status(count >= LIMIT ? HANDOFF : undefined)
}

async function setLook($: EngineInterface): Promise<void> {
  await $.theme.set({ backdrop: { scene: SCENE, glass: { blur: 2, opacity: 0.8 } } })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setLook($)

    await setTokens($, (await $.session.usage()).context.tokens)
    await countAgents($).catch(() => undefined)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await setLook($).catch(() => undefined)

    return result
  })

  on('session.measure', async ($, e, next) => {
    await setTokens($, e.context.tokens)

    return next(e)
  })

  on('prompt.submit', ($, e, next) => next({ ...e, context: [...(e.context ?? []), ESTIMATE_RULE] }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isMainRunning = true
    }

    const result = await next(e)
    await countAgents($).catch(() => undefined)

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    if (e.agentId === undefined) {
      const minutes = parseEstimate(result.answer)

      if (minutes !== null) {
        await startEta($, minutes).catch(() => undefined)
      }
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isMainRunning = false
    }

    const result = await next(e)
    await countAgents($).catch(() => undefined)
    await settle($).catch(() => undefined)

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await countAgents($).catch(() => undefined)

    return result
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.props.scene !== SCENE || (e.surface !== 'desktop' && e.surface !== 'mobile')) {
      return next(e)
    }

    const count = await read($, tokens)
    const { Svg } = $.ui.resolve(e)

    return (
      <Svg
        source={scene(count)}
        alt={`Context ${Math.round(count / 1000)}k of 600k`}
        isInteractive
      />
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const running = await read($, agents)
    const count = await read($, tokens)
    const label = workLabel(e.props.isWorking, running)
    const estimate = await read($, eta)
    const countdown = estimate === null ? null : etaLabel(estimate.minutes, estimate.startedAt, await read($, clock))
    const table = $.ui.resolve(e)
    const { Box, Progress, Text } = table
    const blocks =
      'Svg' in table ? (
        <table.Svg source={strip(count)} alt={figure(count)} />
      ) : (
        <Text dimColor>{'\u25cf'.repeat(Math.floor(stripLit(count) / 10)) + '\u25cb'.repeat(24 - Math.floor(stripLit(count) / 10))}</Text>
      )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={2}>
            {label === null ? <Text dimColor>Idle: nothing running</Text> : <Progress label={label} />}
            {countdown === null ? null : (
              <Text color={countdown.isOver ? 'warning' : undefined}>{countdown.text}</Text>
            )}
          </Box>
          <Text color={count >= LIMIT ? 'warning' : undefined} dimColor={count < LIMIT}>
            {figure(count)}
          </Text>
        </Box>
        {blocks}
      </Box>
    )
  })
}
