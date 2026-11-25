export type HeatEta = { minutes: number; startedAt: number }
export type HeatTask = { id: string; kind: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'context-heat': { tokens: number; agents: number; eta: HeatEta | null; clock: number; tasks: HeatTask[] }
  }
}
