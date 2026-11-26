// FEATURE SWITCHES
//
// Every feature of the mod, one switch each. Set one to false to turn that feature off completely:
// no drawing, no notice, no note added to prompts, no hook left doing its work.
// Each switch is also a setting of the plugin (plugin.json, "userConfig"), so a feature can be turned off
// from the plugin's settings without editing this file. A feature runs only while both say true.
export const FEATURES = {
  // Faint blocks behind the conversation in the desktop app that stack up as the context fills.
  backdrop: true,
  // The strip of 240 dots across the row, one for every 2.5k tokens.
  dots: true,
  // The context figure on the right of the row, for example "362k of 600k".
  contextFigure: true,
  // "Working: ..." or "Idle: nothing running" on the left of the row.
  workStatus: true,
  // Counts background commands and workflows as work ("1 command running"). Shows only with workStatus.
  backgroundTasks: true,
  // The countdown from Claude's "Estimate: N minutes", for example "6:40 left of 10 min".
  countdown: true,
  // A short note on each prompt asking Claude to state an estimate. Only added while countdown or
  // notifications is on, since nothing else reads the estimate.
  estimateNote: true,
  // At 600k: the status line entry, the figure in the warning colour and the slow pulse of the background.
  handoffWarning: true,
  // From 600k to 750k the dots and background blocks deepen to dark red.
  redPastLimit: true,
  // Once per session at 585k, a notice to run /handoff; also adds the /handoff command.
  handoffNudge: true,
  // "Cache warm", then "Cache cold in m:ss", then "Cache cold", on a small line under the row.
  cacheTimer: true,
  // "Compacted 2 times" on the small line under the row; hidden until the first compaction.
  compactionCount: true,
  // The row turns amber and says "Waiting on you" while a question or a permission prompt is open.
  waitingOnYou: true,
  // A system notification when a session is done, or starts waiting on you. Not for turns under 30 seconds.
  notifications: true,
  // "N agents running" opens a list of the agents with a countdown each. Shows only with workStatus.
  agentList: true,
  // Leaves out time the Mac sleeps or the app is closed, and clears stale work after a restart.
  sleepFix: true,
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { HeatAgent, HeatAgentEta, HeatCache, HeatEta, HeatTask, HeatWait } from '../types'

export type Feature = keyof typeof FEATURES
export type Features = Record<Feature, boolean>

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

// The context size at which the handoff nudge shows, once per session.
export const NUDGE_AT = 585_000
const NUDGE_TEXT = '585k: run /handoff, then open a new session'

// How long the prompt cache is taken to last when a reply does not say. An assumption: the engine
// reports the lifetime of each cache write (5 minutes or 1 hour) and that is used where it is given.
export const CACHE_TTL_MINUTES = 60

// Work shorter than this raises no notification.
export const NOTIFY_FLOOR = 30 * 1000

const HANDOFF_PROMPT =
  "Update the handoff document for the current workstream so the next session can pick up where this one stops: " +
  'what was done, where it stands, what is left, and anything found the hard way. Then tell me to open a new ' +
  "session in this repo's folder."

const tokens = atom({ plugin: 'context-heat', key: 'tokens' } as const, 0)
const agents = atom({ plugin: 'context-heat', key: 'agents' } as const, 0)
const eta = atom({ plugin: 'context-heat', key: 'eta' } as const, null)
const clock = atom({ plugin: 'context-heat', key: 'clock' } as const, 0)
const tasks = atom({ plugin: 'context-heat', key: 'tasks' } as const, [])
const crew = atom({ plugin: 'context-heat', key: 'crew' } as const, [])
const agentEtas = atom({ plugin: 'context-heat', key: 'agentEtas' } as const, {})
const listOpen = atom({ plugin: 'context-heat', key: 'listOpen' } as const, false)
const waiting = atom({ plugin: 'context-heat', key: 'waiting' } as const, null)
const cache = atom({ plugin: 'context-heat', key: 'cache' } as const, null)
const compactions = atom({ plugin: 'context-heat', key: 'compactions' } as const, 0)
const nudged = atom({ plugin: 'context-heat', key: 'nudged' } as const, false)
const busySince = atom({ plugin: 'context-heat', key: 'busySince' } as const, null)
const title = atom({ plugin: 'context-heat', key: 'title' } as const, '')

// A background task nothing has reported on for this long is taken to be gone.
const TASK_TTL = 12 * 60 * 60 * 1000

// A gap this long between one-second ticks means the Mac slept or the app was closed.
const PAUSE = 20 * 1000

const TASK_WORDS: Record<string, readonly [string, string]> = {
  shell: ['command', 'commands'],
  workflow: ['workflow', 'workflows'],
  monitor: ['monitor', 'monitors'],
}

const ESTIMATE_RULE =
  'Before starting any piece of work that edits files or runs commands, state one total time estimate ' +
  'on a line of its own, in exactly this form: "Estimate: N minutes", N a whole number. State it once ' +
  'for each piece of work, before the first tool call, and again only when a new piece of work begins. ' +
  'A plain answer that needs no work gets no estimate.'

const AGENT_ESTIMATE_RULE =
  'Before your first tool call, state one total time estimate for this task on a line of its own, in exactly ' +
  'this form: "Estimate: N minutes", N a whole number. State it once.'

let timer: { cancel: () => void } | null = null
let isMainRunning = false
let F: Features = features({})
let mode = 'default'

// The switches in force: FEATURES and the plugin's settings must both say on, then the dependencies apply.
export function features(options: PluginOptions): Features {
  const on = { ...FEATURES }

  for (const name of Object.keys(FEATURES) as Feature[]) {
    on[name] = FEATURES[name] && options[name] !== false
  }

  on.backgroundTasks = on.backgroundTasks && on.workStatus
  on.agentList = on.agentList && on.workStatus
  on.estimateNote = on.estimateNote && (on.countdown || on.notifications)

  return on
}

// Whether the row above the message box has anything to show.
export function hasRow(f: Features): boolean {
  return f.workStatus || f.countdown || f.dots || f.contextFigure || f.cacheTimer || f.compactionCount || f.waitingOnYou
}

const STOPS = [
  [55, 138, 221],
  [29, 158, 117],
  [242, 192, 55],
  [239, 122, 39],
  [214, 40, 40],
] as const

// How far past 600k the session is, 0 at the limit to 1 at 750k; always 0 with redPastLimit off.
export function overrun(count: number, isRed = true): number {
  return isRed ? Math.max(0, Math.min(1, (count - LIMIT) / OVER)) : 0
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
export function scene(count: number, isPulsing = true, isRed = true): string {
  const lit = blocksLit(count)
  const isFull = isPulsing && count >= LIMIT
  const over = overrun(count, isRed)
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
export function strip(count: number, isRed = true): string {
  const lit = stripLit(count)
  const over = overrun(count, isRed)
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

export function figure(count: number, isWarning = true): string {
  const thousands = Math.round(count / 1000)

  return isWarning && count >= LIMIT ? `${thousands}k: write the handoff` : `${thousands}k of 600k`
}

// True the first time a session reaches 585k; false before and after.
export function nudgeDue(count: number, isNudged: boolean): boolean {
  return count >= NUDGE_AT && !isNudged
}

// Background work the engine still holds for the session, by kind: commands, workflows, monitors.
// Subagents are left out here: the agent count already has them.
export function backgroundParts(kinds: readonly string[]): string[] {
  const counts = new Map<string, number>()

  for (const kind of kinds) {
    if (kind !== 'subagent') {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }

  return [...counts].map(([kind, count]) => {
    const words = TASK_WORDS[kind] ?? ['background task', 'background tasks']

    return `${count} ${count === 1 ? words[0] : words[1]} running`
  })
}

export function agentWords(running: number): string {
  return `${running} ${running === 1 ? 'agent' : 'agents'} running`
}

export function workParts(isReplying: boolean, running: number, kinds: readonly string[] = []): string[] {
  const parts: string[] = []

  if (isReplying) {
    parts.push('Claude is replying')
  }

  if (running > 0) {
    parts.push(agentWords(running))
  }

  parts.push(...backgroundParts(kinds))

  return parts
}

export function workLabel(isReplying: boolean, running: number, kinds: readonly string[] = []): string | null {
  const parts = workParts(isReplying, running, kinds)

  return parts.length === 0 ? null : `Working: ${parts.join(', ')}`
}

// The minutes in "Estimate: 10 minutes" or "On it. Estimate 25 min"; null where a reply states none.
// A report of work already done ("estimate 5 min, actual 3") is not a new estimate.
export function parseEstimate(text: string): number | null {
  const found = /\bestimate[: \t*_]+(?:about[ \t]+|~)?(\d{1,3})[ \t]*min(?:ute)?s?\b(?![^.\n]*\bactual\b)/i.exec(text)
  const minutes = found === null ? 0 : Number(found[1])

  return minutes > 0 ? minutes : null
}

// Seconds as "m:ss".
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function secondsSince(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 1000))
}

// "6:40 left of 10 min", or "3:12 over the 10 min estimate" once it has run past.
export function etaLabel(minutes: number, startedAt: number, now: number): { text: string; isOver: boolean } {
  const left = minutes * 60 - secondsSince(startedAt, now)

  return left >= 0
    ? { text: `${clockText(left)} left of ${minutes} min`, isOver: false }
    : { text: `${clockText(-left)} over the ${minutes} min estimate`, isOver: true }
}

// One agent's line: "9:42 left of 12 min", "3:05 over 15 min", or "running 4:12" with no estimate.
export function agentLabel(
  estimate: HeatAgentEta | undefined,
  startedAt: number,
  now: number,
): { text: string; isOver: boolean } {
  if (estimate === undefined) {
    return { text: `running ${clockText(secondsSince(startedAt, now))}`, isOver: false }
  }

  const left = estimate.minutes * 60 - secondsSince(estimate.at, now)

  return left >= 0
    ? { text: `${clockText(left)} left of ${estimate.minutes} min`, isOver: false }
    : { text: `${clockText(-left)} over ${estimate.minutes} min`, isOver: true }
}

// The cache line: warm while work runs, then a countdown to cold, warning colour in the last minute.
export function cacheLabel(
  isActive: boolean,
  last: HeatCache | null,
  now: number,
): { text: string; isWarning: boolean } | null {
  if (last === null) {
    return null
  }

  if (isActive) {
    return { text: 'Cache warm', isWarning: false }
  }

  const left = Math.ceil((last.at + last.ttlMinutes * 60_000 - now) / 1000)

  return left > 0
    ? { text: `Cache cold in ${clockText(left)}`, isWarning: left <= 60 }
    : { text: 'Cache cold', isWarning: false }
}

// How long a reply's cache write lasts, in minutes, from the usage it reported; null where it wrote none.
export function cacheTtl(usage: {
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}): number | null {
  if ((usage.ephemeral_1h_input_tokens ?? 0) > 0) {
    return 60
  }

  if ((usage.ephemeral_5m_input_tokens ?? 0) > 0) {
    return 5
  }

  return (usage.cache_creation_input_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0
    ? CACHE_TTL_MINUTES
    : null
}

export function compactionLabel(count: number): string | null {
  return count <= 0 ? null : `Compacted ${count} ${count === 1 ? 'time' : 'times'}`
}

export function waitingLabel(kind: HeatWait['kind'], since: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - since) / 60_000))

  return `Waiting on you: a ${kind} is open, ${minutes} min`
}

// A notification is worth sending only once the work has run for 30 seconds.
export function worthNotifying(since: number | null, now: number): boolean {
  return since !== null && now - since >= NOTIFY_FLOOR
}

export function doneText(name: string, estimate: HeatEta | null, now: number): string {
  if (estimate === null) {
    return `${name}: done`
  }

  const actual = Math.max(0, Math.round((now - estimate.startedAt) / 60_000))

  return `${name}: done, estimate ${estimate.minutes}, actual ${actual}`
}

// Whether a permission verdict puts the call to the person: an ask a person can answer, which in auto
// mode means one a hook made (the classifier settles the engine's own).
export function isPersonAsked(
  decision: string,
  approver: string | undefined,
  askedBy: string | undefined,
  permissionMode: string,
): boolean {
  return decision === 'ask' && approver === 'person' && (askedBy !== undefined || permissionMode !== 'auto')
}

export function waitingText(name: string): string {
  return `${name}: waiting on you`
}

// How far to move a countdown's start after a gap, so time asleep or closed is not counted.
// Always 0 with sleepFix off.
export function pausedFor(last: number, now: number, isOn = true): number {
  return isOn && last > 0 && now - last > PAUSE ? now - last - 1000 : 0
}

function needsClock(): boolean {
  return F.countdown || F.cacheTimer || F.waitingOnYou || F.agentList
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const paused = pausedFor(await read($, clock), now, F.sleepFix)
  const running = await read($, eta)

  if (paused > 0 && running !== null) {
    const moved: HeatEta = { minutes: running.minutes, startedAt: running.startedAt + paused }
    await update($, eta, () => moved)
  }

  await update($, clock, () => now)
}

function startTimer($: EngineInterface): void {
  if (timer === null && needsClock()) {
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

async function sessionTitle($: EngineInterface): Promise<string> {
  const named = await read($, title)

  if (named !== '') {
    return named
  }

  const cwd = await $.session.cwd()

  return cwd.split('/').filter(part => part !== '').pop() ?? 'Claude'
}

async function notify($: EngineInterface, text: string): Promise<void> {
  await $.ui.notify(text).catch(() => undefined)
}

// The work ends when the main turn is over and no agent or background task is still running:
// the countdown clears and, for work of 30 seconds or more, the done notification goes out.
async function settle($: EngineInterface): Promise<void> {
  const held = F.backgroundTasks ? (await read($, tasks)).length : 0

  if (isMainRunning || held > 0 || (await read($, agents)) > 0) {
    return
  }

  const running = await read($, eta)
  const since = await read($, busySince)

  if (since !== null) {
    await update($, busySince, () => null)

    if (F.notifications) {
      const now = await $.clock.now()

      if (worthNotifying(since, now)) {
        await notify($, doneText(await sessionTitle($), running, now))
      }
    }
  }

  if (running !== null) {
    await update($, eta, () => null)
  }
}

// The ids of background tasks a notification says have ended.
export function endedTasks(text: string): string[] {
  const ended: string[] = []
  const blocks = text.split('<task-notification>').slice(1)

  for (const block of blocks) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1]
    const status = /<status>([^<]+)<\/status>/.exec(block)?.[1]

    if (id !== undefined && status !== undefined && status !== 'running' && status !== 'pending') {
      ended.push(id.trim())
    }
  }

  return ended
}

// The kinds of the background tasks still held, the stale ones dropped.
export function liveKinds(held: readonly HeatTask[], now: number): string[] {
  return held.filter(task => now - task.at < TASK_TTL).map(task => task.kind)
}

async function addTask($: EngineInterface, id: string, kind: string): Promise<void> {
  const at = await $.clock.now()
  await update($, tasks, held => [...(held ?? []).filter(task => task.id !== id), { id, kind, at }])
}

async function dropTasks($: EngineInterface, ids: readonly string[]): Promise<void> {
  const held = await read($, tasks)

  if (held.some(task => ids.includes(task.id))) {
    await update($, tasks, now => (now ?? []).filter(task => !ids.includes(task.id)))
  }
}

// Drops tasks nothing has reported on for a long time, so a lost notice cannot leave the row on Working for good.
async function pruneTasks($: EngineInterface): Promise<void> {
  const held = await read($, tasks)
  const now = await $.clock.now()

  if (liveKinds(held, now).length !== held.length) {
    await update($, tasks, list => (list ?? []).filter(task => now - task.at < TASK_TTL))
  }
}

// Where the engine's own Stop report reaches the mod, it is the whole truth.
async function setTasks($: EngineInterface, reported: readonly { id: string; type: string }[]): Promise<void> {
  const at = await $.clock.now()
  const next: HeatTask[] = reported.filter(task => task.type !== 'subagent').map(task => ({ id: task.id, kind: task.type, at }))
  await update($, tasks, () => next)
}

async function countAgents($: EngineInterface): Promise<void> {
  const list = await $.agent.list()
  const live = list.filter(agent => agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting')

  if (live.length !== (await read($, agents))) {
    await update($, agents, () => live.length)
  }

  if (!F.agentList) {
    return
  }

  const rows: HeatAgent[] = live.map(agent => ({ id: agent.id, description: agent.description, startedAt: agent.startTime }))
  const known = await read($, crew)

  if (JSON.stringify(rows) !== JSON.stringify(known)) {
    await update($, crew, () => rows)
  }

  const ids = new Set(rows.map(row => row.id))
  const stated = await read($, agentEtas)

  if (Object.keys(stated).some(id => !ids.has(id))) {
    await update($, agentEtas, all => Object.fromEntries(Object.entries(all ?? {}).filter(([id]) => ids.has(id))))
  }
}

async function noteAgentEstimate($: EngineInterface, agentId: string, minutes: number): Promise<void> {
  const stated = (await read($, agentEtas))[agentId]

  if (stated?.minutes !== minutes) {
    const at = await $.clock.now()
    await update($, agentEtas, all => ({ ...(all ?? {}), [agentId]: { minutes, at } }))
  }
}

async function setTokens($: EngineInterface, count: number | undefined): Promise<void> {
  if (count === undefined) {
    return
  }

  if (count !== (await read($, tokens))) {
    await update($, tokens, () => count)
  }

  if (F.handoffWarning) {
    $.ui.status(count >= LIMIT ? HANDOFF : undefined)
  }

  if (F.handoffNudge && nudgeDue(count, await read($, nudged))) {
    await update($, nudged, () => true)
    $.ui.toast(NUDGE_TEXT, { timeoutMs: 30_000 })
  }
}

async function setLook($: EngineInterface): Promise<void> {
  await $.theme.set({ backdrop: { scene: SCENE, glass: { blur: 2, opacity: 0.8 } } })
}

async function addCommand($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'handoff',
    description: 'Update the handoff document for this workstream, then open a new session',
  })
}

async function startWaiting($: EngineInterface, kind: HeatWait['kind'], id: string, loop: string | undefined): Promise<void> {
  const now = await $.clock.now()
  const open: HeatWait = { kind, since: now, id, loop: loop ?? null }
  await update($, waiting, () => open)

  if (F.notifications && worthNotifying(await read($, busySince), now)) {
    await notify($, waitingText(await sessionTitle($)))
  }
}

// Ends the wait on that call, or every wait in that loop, or (neither given) any wait.
async function endWaiting($: EngineInterface, match: { id?: string; loop?: string | null }): Promise<void> {
  const open = await read($, waiting)

  if (open === null) {
    return
  }

  if (match.id !== undefined && open.id !== match.id) {
    return
  }

  if (match.loop !== undefined && open.loop !== match.loop) {
    return
  }

  await update($, waiting, () => null)
}

async function noteCache($: EngineInterface, at: number, ttlMinutes: number | null): Promise<void> {
  if (ttlMinutes !== null) {
    const last: HeatCache = { at, ttlMinutes }
    await update($, cache, () => last)
  }
}

export const register: Register = (on, options) => {
  F = features(options)
  const isWatchingWaits = F.waitingOnYou || F.notifications

  on('session.start', async ($, e, next) => {
    // Coming back after the app was closed: the turn and its background commands ended with it.
    if (pausedFor(await read($, clock), await $.clock.now(), F.sleepFix) > 0) {
      await update($, tasks, () => [])
      await update($, eta, () => null)
    }

    startTimer($)

    if (F.backdrop) {
      await setLook($)
    }

    if (F.handoffNudge) {
      await addCommand($).catch(() => undefined)
    }

    await setTokens($, (await $.session.usage()).context.tokens)
    await countAgents($).catch(() => undefined)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)

    if (F.backdrop) {
      await setLook($).catch(() => undefined)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    await setTokens($, e.context.tokens)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A background task's notification: note which tasks ended, and add no estimate note to it.
    // The turn it starts settles the work when it completes.
    if (e.origin?.kind === 'task-notification') {
      if (F.backgroundTasks) {
        await dropTasks($, endedTasks(e.text)).catch(() => undefined)
      }

      return next(e)
    }

    return F.estimateNote ? next({ ...e, context: [...(e.context ?? []), ESTIMATE_RULE] }) : next(e)
  })

  if (F.backgroundTasks) {
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const ran = await next(e)
      const id = ran.deny === undefined ? (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId : undefined

      if (id !== undefined) {
        await addTask($, id, 'shell').catch(() => undefined)
      }

      return ran
    })

    on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
      const ran = await next(e)
      const id = ran.deny === undefined ? (ran.result as { taskId?: string } | undefined)?.taskId : undefined

      if (id !== undefined) {
        await addTask($, id, 'workflow').catch(() => undefined)
      }

      return ran
    })

    on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
      const ran = await next(e)
      const id = ran.deny === undefined ? (ran.result as { task_id?: string } | undefined)?.task_id : undefined

      if (id !== undefined) {
        await dropTasks($, [id]).catch(() => undefined)
      }

      return ran
    })
  }

  if (isWatchingWaits) {
    // A question put to the person is open for as long as its call is.
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
      await startWaiting($, 'question', e.tool_use_id, e.agentId).catch(() => undefined)

      try {
        return await next(e)
      } finally {
        await endWaiting($, { id: e.tool_use_id }).catch(() => undefined)
      }
    })

    // A call the engine puts to the person opens a permission prompt. In auto mode the classifier
    // answers the engine's own asks, so only an ask a hook made is taken to reach the person there.
    on('tool.check', async ($, e, next) => {
      const verdict = await next(e)

      if (
        isPersonAsked(verdict.decision, e.approver, verdict.plugin, mode) &&
        e.tool_use_id !== undefined &&
        e.op === undefined &&
        e.tool !== 'AskUserQuestion'
      ) {
        await startWaiting($, 'permission', e.tool_use_id, e.agentId).catch(() => undefined)
      }

      return verdict
    })

    // The permission mode, and for notifications the session's title.
    on('classic.UserPromptSubmit', async ($, e, next) => {
      mode = e.permission_mode ?? mode
      const result = await next(e)
      const named = e.session_title?.trim()

      if (F.notifications && named !== undefined && named !== '' && named !== (await read($, title))) {
        await update($, title, () => named)
      }

      return result
    })

    on('classic.PostToolUse', async ($, e, next) => {
      mode = e.permission_mode ?? mode
      const result = await next(e)
      await endWaiting($, { id: e.tool_use_id }).catch(() => undefined)

      return result
    })

    on('classic.PostToolUseFailure', async ($, e, next) => {
      const result = await next(e)
      await endWaiting($, { id: e.tool_use_id }).catch(() => undefined)

      return result
    })

    on('classic.PermissionDenied', async ($, e, next) => {
      const result = await next(e)
      await endWaiting($, { id: e.tool_use_id }).catch(() => undefined)

      return result
    })
  }

  if (F.handoffNudge) {
    on('command.run', { command: 'handoff' }, async ($, e, next) => {
      // A command.run hook cannot submit a prompt itself (the turn would wait on it), so a timer does it.
      $.clock.after(0, () => {
        void $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true }).catch(() => undefined)
      })

      return { text: 'Asking Claude to update the handoff.' }
    })
  }

  if (F.compactionCount) {
    on('session.compact', async ($, e, next) => {
      const result = await next(e)

      if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
        await update($, compactions, count => (count ?? 0) + 1).catch(() => undefined)
      }

      return result
    })
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isMainRunning = true

      if ((await read($, busySince)) === null) {
        const now = await $.clock.now()
        await update($, busySince, () => now)
      }
    }

    const result = await next(e)
    await countAgents($).catch(() => undefined)

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()

    // A new request in a loop means the tools of its last step have all finished.
    if (isWatchingWaits) {
      await endWaiting($, { loop: e.agentId ?? null }).catch(() => undefined)
    }

    const result = yield* next(e)
    const minutes = parseEstimate(result.answer)

    if (e.agentId === undefined) {
      if (minutes !== null && (F.countdown || F.notifications)) {
        await startEta($, minutes).catch(() => undefined)
      }

      if (F.cacheTimer && result.usage !== null) {
        await noteCache($, sentAt, cacheTtl(result.usage)).catch(() => undefined)
      }
    } else if (minutes !== null && F.agentList) {
      await noteAgentEstimate($, e.agentId, minutes).catch(() => undefined)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isMainRunning = false
    }

    // A loop whose turn is over (answered, stopped or failed) waits on nobody.
    if (isWatchingWaits) {
      await endWaiting($, { loop: e.agentId ?? null }).catch(() => undefined)
    }

    const result = await next(e)
    await countAgents($).catch(() => undefined)

    if (F.backgroundTasks) {
      await pruneTasks($).catch(() => undefined)
    }

    await settle($).catch(() => undefined)

    return result
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)

    if (e.agent_id === undefined) {
      if (F.backgroundTasks) {
        await setTasks($, e.background_tasks ?? []).catch(() => undefined)
      }

      await countAgents($).catch(() => undefined)
      await settle($).catch(() => undefined)
    }

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    // Each agent is asked to state its own estimate, which its line in the agent list counts down from.
    const result = await next(F.agentList ? { ...e, prompt: `${e.prompt}\n\n${AGENT_ESTIMATE_RULE}` } : e)
    await countAgents($).catch(() => undefined)

    return result
  })

  if (F.backdrop) {
    on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
      if (e.props.scene !== SCENE || (e.surface !== 'desktop' && e.surface !== 'mobile')) {
        return next(e)
      }

      const count = await read($, tokens)
      const { Svg } = $.ui.resolve(e)

      return (
        <Svg
          source={scene(count, F.handoffWarning, F.redPastLimit)}
          alt={`Context ${Math.round(count / 1000)}k of 600k`}
          isInteractive
        />
      )
    })
  }

  if (hasRow(F)) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      if (e.props.hasSurvey) {
        return next(e)
      }

      const running = await read($, agents)
      const count = await read($, tokens)
      const kinds = F.backgroundTasks ? (await read($, tasks)).map(task => task.kind) : []
      const isWorking = workLabel(e.props.isWorking, running, kinds) !== null
      const open = F.waitingOnYou ? await read($, waiting) : null
      const estimate = F.countdown ? await read($, eta) : null
      const last = F.cacheTimer ? await read($, cache) : null
      const compacted = F.compactionCount ? compactionLabel(await read($, compactions)) : null
      const isListOpen = F.agentList && running > 0 ? await read($, listOpen) : false
      const team = isListOpen ? await read($, crew) : []
      const stated = isListOpen ? await read($, agentEtas) : {}
      const isActive = isWorking && open === null
      const isTicking = estimate !== null || open !== null || (last !== null && !isActive) || team.length > 0
      // Read the clock only while something on the row counts, so an idle row is not redrawn every second.
      const now = isTicking ? await read($, clock) : 0
      const countdown = estimate === null ? null : etaLabel(estimate.minutes, estimate.startedAt, now)
      const cached = cacheLabel(isActive, last, now)
      const isLimit = F.handoffWarning && count >= LIMIT
      const table = $.ui.resolve(e)
      const { Box, Button, Text } = table
      // A surface without Progress (the test kit's, an older build) shows the words alone.
      const busy = (label: string) =>
        (table.Progress as unknown) === undefined ? <Text>{label}</Text> : <table.Progress label={label} />
      const toggle = () => update($, listOpen, isOpen => !(isOpen ?? false))

      let status = null

      if (open !== null) {
        status = (
          <Text color="warning" bold>
            {waitingLabel(open.kind, open.since, now)}
          </Text>
        )
      } else if (F.workStatus && F.agentList && running > 0) {
        const others = workParts(e.props.isWorking, 0, kinds)

        status = (
          <Box flexDirection="row" gap={1}>
            {busy(others.length === 0 ? 'Working:' : `Working: ${others.join(', ')},`)}
            <Button key="agents" plain onPress={toggle}>
              {`${agentWords(running)} ${isListOpen ? '▾' : '▸'}`}
            </Button>
          </Box>
        )
      } else if (F.workStatus) {
        const label = workLabel(e.props.isWorking, running, kinds)
        status = label === null ? <Text dimColor>Idle: nothing running</Text> : busy(label)
      }

      const blocks = !F.dots ? null : 'Svg' in table ? (
        <table.Svg source={strip(count, F.redPastLimit)} alt={figure(count, F.handoffWarning)} />
      ) : (
        <Text dimColor>{'●'.repeat(Math.floor(stripLit(count) / 10)) + '○'.repeat(24 - Math.floor(stripLit(count) / 10))}</Text>
      )

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={2}>
              {status}
              {countdown === null ? null : (
                <Text color={countdown.isOver ? 'warning' : undefined}>{countdown.text}</Text>
              )}
            </Box>
            {F.contextFigure ? (
              <Text color={isLimit ? 'warning' : undefined} dimColor={!isLimit}>
                {figure(count, F.handoffWarning)}
              </Text>
            ) : null}
          </Box>
          {team.length === 0 ? null : (
            <Box flexDirection="column" paddingLeft={2}>
              {team.map(agent => {
                const line = agentLabel(stated[agent.id], agent.startedAt, now)

                return (
                  <Box key={agent.id} flexDirection="row" gap={2}>
                    <Text>{agent.description}</Text>
                    <Text color={line.isOver ? 'warning' : undefined} dimColor={!line.isOver}>
                      {line.text}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )}
          {blocks}
          {cached === null && compacted === null ? null : (
            <Box flexDirection="row" gap={2}>
              {cached === null ? null : (
                <Text color={cached.isWarning ? 'warning' : undefined} dimColor={!cached.isWarning}>
                  {cached.text}
                </Text>
              )}
              {compacted === null ? null : <Text dimColor>{compacted}</Text>}
            </Box>
          )}
        </Box>
      )
    })
  }
}
