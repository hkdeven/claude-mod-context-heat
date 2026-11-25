export type HeatState = { tokens: number; agents: number }

declare module 'claude-code' {
  interface PluginState {
    'context-heat': { tokens: number; agents: number }
  }
}
