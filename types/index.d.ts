// What xray-loop records of one turn, all times in ms from the turn's start.

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ChunkKind = 'thinking' | 'tool' | 'input' | 'text' | 'stop'

export type Chunk = { t: number; k: ChunkKind; i: number; s: string }

export type Step = {
  agentId?: string
  index: number
  model: string
  messageCount: number
  t0: number
  t1?: number
  chunks: Chunk[]
  dropped: number
  stop?: string
  usage?: Usage
}

export type Row = { t: number; door: string; name: string; agentId?: string; chars: number; text: string }

export type Section = { id: string; scope: 'shared' | 'session'; chars: number; text: string }

export type ToolInfo = { name: string; deferred: boolean }

export type ToolRun = {
  id: string
  tool: string
  agentId?: string
  input: string
  t0: number
  t1?: number
  result?: string
  resultChars?: number
  isError?: boolean
  decision?: string
  reason?: string
  tCheck?: number
}

export type Spawn = {
  toolUseId: string
  agentId?: string
  type: string
  model?: string
  prompt: string
  t: number
  t1?: number
  answer?: string
}

export type TurnRec = {
  n: number
  prompt: string
  isOpen: boolean
  t1?: number
  sections: Section[]
  sectionsAt?: number
  sectionsReused: boolean
  tools: ToolInfo[]
  before: { rows: number; chars: number }
  rows: Row[]
  steps: Step[]
  runs: ToolRun[]
  spawns: Spawn[]
  answer?: string
}

// cursor null means "follow the latest event"; t, when set, replays the turn as it
// stood at that moment (ms from the turn's start) and picks the event from it.
export type View = { cursor: number | null; t: number | null; item: string | null; full: boolean; timeline: boolean }

declare module 'claude-code' {
  interface PluginState {
    'xray-loop': { turn: TurnRec | null; view: View }
  }
}
