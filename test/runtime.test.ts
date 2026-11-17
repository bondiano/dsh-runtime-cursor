import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCursorRuntime } from '../index.js'

test('Cursor uses workspace and native tools; preserves SDK session identity and usage', async () => {
  let options
  const agent = { agentId: 'cursor-1', getUsage: async () => ({ tokens: 12 }),
    send: async () => ({ async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }; yield { type: 'tool_call', status: 'completed' } }, wait: async () => ({ status: 'finished', result: 'ok' }) }), close() {} }
  const runtime = createCursorRuntime({ loadSdk: async () => ({ Agent: { create: async input => { options = input; return agent }, resume: async () => agent } }) })
  assert.deepEqual(await runtime.create({ cwd: '/work', model: 'model-a' }), { id: 'cursor-1', cwd: '/work' })
  assert.deepEqual(options, { model: { id: 'model-a' }, local: { cwd: '/work' } })
  const events = await Array.fromAsync(runtime.send('cursor-1', { text: 'go' }, { runId: 'run-a' }))
  assert.deepEqual(events.map(event => event.type), ['text', 'tool-result', 'completed'])
  assert.deepEqual(await runtime.getUsage('cursor-1'), { tokens: 12 })
  assert.equal(runtime.capabilities().fork, false)
  await runtime.close('cursor-1')
  await runtime.resume('cursor-1', { cwd: '/work' })
})

test('cancel only targets the matching run and abort during SDK send cancels late run', async () => {
  let resolveSend
  let cancelled = 0
  const runtime = createCursorRuntime({ loadSdk: async () => ({ Agent: { create: async () => ({ agentId: 'a', send: () => new Promise(resolve => { resolveSend = resolve }) }) } }) })
  await runtime.create({ cwd: '/work' })
  const iterator = runtime.send('a', 'go', { runId: 'one' })
  const next = iterator.next()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.cancel('a', 'other')
  await runtime.cancel('a', 'one')
  resolveSend({ cancel: async () => { cancelled++ }, async *stream() {}, wait: async () => ({ status: 'cancelled' }) })
  assert.equal((await next).value?.status, 'cancelled')
  await iterator.next()
  assert.equal(cancelled, 1)
})

test('reuses private DSH credential without including it in session metadata and rejects failed result', async () => {
  let created
  const runtime = createCursorRuntime({ getCredential: async () => 'private-key', loadSdk: async () => ({ Agent: {
    create: async options => {
      created = options
      return { agentId: 'a', send: async () => ({ async *stream() {}, wait: async () => ({ status: 'error' }) }) }
    },
  } }) })
  assert.deepEqual(await runtime.create({ cwd: '/work' }), { id: 'a', cwd: '/work' })
  assert.equal(created.apiKey, 'private-key')
  await assert.rejects(Array.fromAsync(runtime.send('a', 'go', { runId: 'r' })), /Cursor run failed/)
})

test('catalog lists deduplicated Cursor models with the private credential', async () => {
  let requested
  const runtime = createCursorRuntime({
    getCredential: async () => 'private-key',
    loadSdk: async () => ({ Agent: {}, Cursor: { models: { list: async options => {
      requested = options
      return [{ id: 'm1', displayName: 'Model One' }, { id: 'm1', displayName: 'Duplicate' }, { id: 'm2' }]
    } } } }),
  })
  assert.deepEqual(await runtime.catalog(), {
    models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'm2' }],
  })
  assert.deepEqual(requested, { apiKey: 'private-key' })
})
