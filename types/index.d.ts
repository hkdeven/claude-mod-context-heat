export type HeatEta = { minutes: number; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'context-heat': { tokens: number; agents: number; eta: HeatEta | null; clock: number }
  }
}
