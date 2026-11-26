export type HeatEta = { minutes: number; startedAt: number }
export type HeatTask = { id: string; kind: string; at: number }
export type HeatAgent = { id: string; description: string; startedAt: number }
export type HeatAgentEta = { minutes: number; at: number }
export type HeatWait = { kind: 'question' | 'permission'; since: number; id: string; loop: string | null }
export type HeatCache = { at: number; ttlMinutes: number }

declare module 'claude-code' {
  interface PluginState {
    'context-heat': {
      tokens: number
      agents: number
      eta: HeatEta | null
      clock: number
      tasks: HeatTask[]
      crew: HeatAgent[]
      agentEtas: Record<string, HeatAgentEta>
      listOpen: boolean
      waiting: HeatWait | null
      cache: HeatCache | null
      compactions: number
      nudged: boolean
      busySince: number | null
      title: string
    }
  }
}
