/** Autonomous Cursor harness adapter. The separate dsh-cursor plugin remains an LLM provider. */
import type { StateValue } from 'xstate'
import { initialRunState, nextRunState, settleRunState } from './lib/run.machine.js'

/** One content block a run stream delivers. */
interface ProviderBlock {
  type: string
  text?: string
}

/** One row of the Cursor run stream. */
interface ProviderEvent {
  type: string
  status?: string
  text?: string
  usage?: unknown
  message?: { content?: ProviderBlock[] }
}

/** One live Cursor run the adapter streams and cancels. */
interface SdkRun {
  stream(): AsyncIterable<ProviderEvent>
  wait(): Promise<{ status: string; result?: string }>
  cancel(): Promise<void>
}

/** Agent surface of the Cursor SDK used by this adapter. */
interface SdkAgent {
  agentId: string
  send(input: string): Promise<SdkRun>
  getUsage(): Promise<unknown>
  listArtifacts?(): Promise<unknown[]>
  close?(): Promise<void>
  [Symbol.asyncDispose]?: () => Promise<void>
}

/** Model row returned by the SDK catalog. */
interface ModelRow {
  id?: unknown
  displayName?: unknown
}

/** SDK entry points loaded lazily so the plugin boots without the SDK present. */
interface SdkModule {
  Agent: {
    create(options: SdkOptions): Promise<SdkAgent>
    resume(id: string, options: SdkOptions): Promise<SdkAgent>
  }
  Cursor: { models: { list(options?: { apiKey: string }): Promise<ModelRow[]> } }
}

/** Options the SDK expects when an agent is created or resumed. */
interface SdkOptions {
  apiKey?: string
  model?: { id: string } | unknown
  tools?: unknown
  local: { cwd?: string }
}

/** Provider options a caller passes when it opens a session. */
interface RuntimeOptions {
  apiKey?: string
  cwd?: string
  model?: string
  onlyTools?: unknown
}

/** One live run, cancellable by id. */
interface ActiveRun {
  runId?: string
  run: SdkRun | null
  cancelled: boolean
}

/** One adapter session and its machine state. */
interface Session {
  agent: SdkAgent
  cwd?: string
  active: ActiveRun | null
  state: StateValue
}

/** Options of one `send` call. */
interface RunInput {
  runId?: string
  signal?: AbortSignal
}

/** One row the adapter streams back to its caller. */
interface RuntimeEvent {
  type: string
  status?: string
  text?: string
  usage?: unknown
  raw?: unknown
  artifact?: unknown
}

/** Credential record store the plugin reads its key from. */
interface CredentialStore {
  readRecord(key: string): Promise<{
    kind?: string
    payload?: { v?: number; apiKey?: unknown; expiresAt?: number }
  } | undefined>
}

/** Registry the adapter registers itself into. */
interface AgentRuntimeRegistry {
  register(runtime: unknown): () => void
}

/** Cordis context slice used by this adapter. */
export interface HostContext {
  get(name: 'agentRuntime'): AgentRuntimeRegistry
  get(name: 'credentials'): CredentialStore | undefined
  effect(callback: () => unknown, label?: string): unknown
}

/** Runtime dependencies, injectable for tests and headless boots. */
export interface RuntimeDeps {
  loadSdk?: () => Promise<unknown>
  getCredential?: () => Promise<string | undefined>
}

export function createCursorRuntime({ loadSdk = () => import('@cursor/sdk'), getCredential = async () => undefined }: RuntimeDeps = {}) {
  const sessions = new Map<string, Session>()
  const requireSession = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new Error('Unknown Cursor session')
    return session
  }
  const sdkOptions = (options: RuntimeOptions): SdkOptions => ({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.model ? { model: typeof options.model === 'string' ? { id: options.model } : options.model } : {}),
    ...(options.onlyTools ? { tools: options.onlyTools } : {}),
    local: { cwd: options.cwd },
  })
  async function open(options: RuntimeOptions, id?: string) {
    const { Agent } = await loadSdk() as SdkModule
    const apiKey = options.apiKey ?? await getCredential()
    const resolved = sdkOptions({ ...options, apiKey })
    const agent = id ? await Agent.resume(id, resolved) : await Agent.create(resolved)
    sessions.set(agent.agentId, { agent, cwd: options.cwd, active: null, state: initialRunState() })
    return { id: agent.agentId, cwd: options.cwd }
  }
  return {
    id: 'cursor',
    capabilities: () => ({ resume: true, streaming: true, usage: true, cancel: true, fork: false, permissions: false, missions: false, settings: false }),
    async catalog() {
      const { Cursor } = await loadSdk() as SdkModule
      const apiKey = await getCredential()
      const listed = await Cursor.models.list(apiKey ? { apiKey } : undefined)
      const seen = new Set<string>()
      const models: { id: string; name: string }[] = []
      for (const model of listed ?? []) {
        const id = typeof model?.id === 'string' ? model.id : undefined
        if (!id || seen.has(id)) continue
        seen.add(id)
        models.push({ id, name: typeof model.displayName === 'string' ? model.displayName : id })
      }
      return { models }
    },
    create: (options: RuntimeOptions) => open(options),
    resume: async (id: string, options: RuntimeOptions = {}) => sessions.has(id) ? { id, cwd: requireSession(id).cwd } : open(options, id),
    async *send(id: string, message: string | { text: string }, { runId, signal }: RunInput = {}) {
      const session = requireSession(id)
      if (session.active) throw new Error('Cursor session is busy')
      signal?.throwIfAborted()
      session.state = nextRunState(session.state, 'START')
      const active: ActiveRun = { runId, run: null, cancelled: false }
      session.active = active
      const abort = () => { active.cancelled = true; void active.run?.cancel().catch(() => {}) }
      signal?.addEventListener('abort', abort, { once: true })
      let settled = false
      try {
        const run = await session.agent.send(typeof message === 'string' ? message : message.text)
        active.run = run
        if (active.cancelled) await run.cancel()
        for await (const raw of run.stream()) {
          if (raw.type === 'assistant') {
            for (const block of raw.message?.content ?? []) {
              if (block.type === 'text') yield { type: 'text', text: block.text, raw }
            }
          } else if (raw.type === 'tool_call') yield { type: raw.status === 'running' ? 'tool-call' : 'tool-result', raw }
          else if (raw.type === 'usage') yield { type: 'usage', usage: raw.usage, raw }
          else if (raw.type === 'thinking') yield { type: 'reasoning', text: raw.text, raw }
          else if (raw.type === 'task') yield { type: 'task', raw }
          else yield { type: 'provider', raw }
        }
        const result = await run.wait()
        settled = true
        if (!['finished', 'cancelled'].includes(result.status)) throw new Error(`Cursor run failed: ${result.status}`)
        session.state = settleRunState(session.state, result.status === 'cancelled' ? 'CANCEL' : 'COMPLETE')
        yield { type: 'completed', status: result.status, text: result.result, raw: result }
        for (const artifact of await session.agent.listArtifacts?.() ?? []) yield { type: 'artifact', artifact }
      } catch (error) {
        session.state = settleRunState(session.state, 'FAIL')
        throw error
      } finally {
        signal?.removeEventListener('abort', abort)
        if (!settled && active.run) await active.run.cancel().catch(() => {})
        session.state = settleRunState(session.state, active.cancelled ? 'CANCEL' : 'FAIL')
        if (session.active === active) session.active = null
      }
    },
    async cancel(id: string, runId?: string) {
      const active = requireSession(id).active
      if (!active || active.runId !== runId) return
      active.cancelled = true
      await active.run?.cancel()
    },
    async close(id: string) {
      const session = requireSession(id)
      if (session.active) { session.active.cancelled = true; await session.active.run?.cancel() }
      const dispose = session.agent[Symbol.asyncDispose]
      if (dispose) await dispose.call(session.agent)
      else await session.agent.close?.()
      session.state = nextRunState(session.state, 'CLOSE')
      session.state = nextRunState(session.state, 'CLOSED')
      sessions.delete(id)
    },
    getUsage: (id: string) => requireSession(id).agent.getUsage(),
  }
}

export const inject = ['agentRuntime']
export function apply(ctx: HostContext) {
  const adapter = createCursorRuntime({ getCredential: async () => {
    const record = await ctx.get('credentials')?.readRecord('dsh-cursor/default')
    const payload = record?.payload
    if (record?.kind === 'grant' && payload?.v === 1 && typeof payload.apiKey === 'string'
      && (payload.expiresAt === undefined || payload.expiresAt > Date.now())) return payload.apiKey
    return undefined // SDK/environment authentication remains the headless fallback.
  } })
  ctx.effect(() => ctx.get('agentRuntime').register(adapter), 'cursor runtime')
}
