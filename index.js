/** Autonomous Cursor harness adapter. The separate dsh-cursor plugin remains an LLM provider. */
export function createCursorRuntime({ loadSdk = () => import('@cursor/sdk'), getCredential = async () => undefined } = {}) {
  const sessions = new Map()
  const requireSession = id => {
    const session = sessions.get(id)
    if (!session) throw new Error('Unknown Cursor session')
    return session
  }
  const sdkOptions = options => ({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.model ? { model: typeof options.model === 'string' ? { id: options.model } : options.model } : {}),
    ...(options.onlyTools ? { tools: options.onlyTools } : {}),
    local: { cwd: options.cwd },
  })
  async function open(options, id) {
    const { Agent } = await loadSdk()
    const apiKey = options.apiKey ?? await getCredential()
    const resolved = sdkOptions({ ...options, apiKey })
    const agent = id ? await Agent.resume(id, resolved) : await Agent.create(resolved)
    sessions.set(agent.agentId, { agent, cwd: options.cwd, active: null })
    return { id: agent.agentId, cwd: options.cwd }
  }
  return {
    id: 'cursor',
    capabilities: () => ({ resume: true, streaming: true, usage: true, cancel: true, fork: false, permissions: false, missions: false, settings: false }),
    create: options => open(options),
    resume: async (id, options = {}) => sessions.has(id) ? { id, cwd: requireSession(id).cwd } : open(options, id),
    async *send(id, message, { runId, signal } = {}) {
      const session = requireSession(id)
      if (session.active) throw new Error('Cursor session is busy')
      signal?.throwIfAborted()
      const active = { runId, run: null, cancelled: false }
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
        yield { type: 'completed', status: result.status, text: result.result, raw: result }
        for (const artifact of await session.agent.listArtifacts?.() ?? []) yield { type: 'artifact', artifact }
      } finally {
        signal?.removeEventListener('abort', abort)
        if (!settled && active.run) await active.run.cancel().catch(() => {})
        if (session.active === active) session.active = null
      }
    },
    async cancel(id, runId) {
      const active = requireSession(id).active
      if (!active || active.runId !== runId) return
      active.cancelled = true
      await active.run?.cancel()
    },
    async close(id) {
      const session = requireSession(id)
      if (session.active) { session.active.cancelled = true; await session.active.run?.cancel() }
      if (session.agent[Symbol.asyncDispose]) await session.agent[Symbol.asyncDispose]()
      else await session.agent.close()
      sessions.delete(id)
    },
    getUsage: id => requireSession(id).agent.getUsage(),
  }
}

export const inject = ['agentRuntime']
export function apply(ctx) {
  const adapter = createCursorRuntime({ getCredential: async () => {
    const record = await ctx.get('credentials')?.readRecord('dsh-cursor/default')
    const payload = record?.payload
    if (record?.kind === 'grant' && payload?.v === 1 && typeof payload.apiKey === 'string'
      && (payload.expiresAt === undefined || payload.expiresAt > Date.now())) return payload.apiKey
    return undefined // SDK/environment authentication remains the headless fallback.
  } })
  ctx.effect(() => ctx.get('agentRuntime').register(adapter), 'cursor runtime')
}
