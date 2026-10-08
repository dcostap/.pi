import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SPECS = {
  tools: [
    { name: 'subagent_list', description: 'List subagents.', parameters: { type: 'object', properties: {} } },
    { name: 'subagent_wait_for_any', description: 'Wait.', parameters: { type: 'object', properties: { timeout_seconds: { type: 'integer' } } } },
  ],
  instructions: 'Managed subagents: rules.',
}

type Fake = {
  clock: ReturnType<typeof mock.clock>
  registered: string[]
  runs: string[][]
  posts: { endpoint: string; body: any }[]
  submitted: string[]
  pending: string | null
  callResult: { text: string; isError: boolean }
  // Polls answered { pending } before the result.
  jobs: number
  isCallFailing: boolean
  lines: unknown[][] | null
}

// Answers what the mod asks of the engine: processes, HTTP, tools, prompts.
function fakeWorld(on: On): Fake {
  const fake: Fake = { clock: mock.clock(on), registered: [], runs: [], posts: [], submitted: [], pending: null, callResult: { text: 'ok', isError: false }, jobs: 0, isCallFailing: false, lines: null }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', ($, e) => {
    fake.registered.push(e.name)
    return { value: { tool: `mcp__pi-bridge__${e.name}` } }
  })
  on('process.run', ($, e) => {
    fake.runs.push([...e.argv])
    const stdout = e.argv.includes('tools')
      ? JSON.stringify(SPECS)
      : e.argv.includes('ensure') ? '{"port":4000,"token":"t","pid":1,"startedAt":0}\n' : '{"status":"unchanged"}'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    const endpoint = new URL(e.url).pathname
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    fake.posts.push({ endpoint, body })
    let answer: unknown = { ok: true }
    if (endpoint === '/call' && fake.isCallFailing) return { deny: 'connection reset' }
    if (endpoint === '/call' || endpoint === '/job') answer = fake.jobs-- > 0 ? { pending: 'job-1' } : fake.callResult
    if (endpoint === '/state') answer = { text: 'tree', lines: fake.lines, active: 1, pending: 0 }
    if (endpoint === '/drain') {
      answer = { text: fake.pending }
      fake.pending = null
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
  on('prompt.submit', ($, e) => {
    fake.submitted.push(e.text)
    return { text: e.text }
  })
  return fake
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const LINES = [
  [{ text: 'Subagents', color: 'toolTitle', bold: true }, { text: ' · 1 active', color: 'muted' }],
  [{ text: '└─ ', color: 'dim' }, { text: '·', color: 'accent', spinner: true }, { text: ' running', color: 'accent' }],
]

describe('pi-bridge', () => {
  test('registers the hub tools at session start', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    expect(fake.registered).toEqual(['subagent_list', 'subagent_wait_for_any'])
    expect(fake.runs[0]!.at(-1)).toBe('tools')
  })

  test('a tool call starts the hub once and returns its text', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    const first = await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    const second = await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    expect(first.result).toBe('ok')
    expect(second.result).toBe('ok')
    expect(fake.runs.filter(argv => argv.includes('ensure'))).toHaveLength(1)
    expect(fake.posts.find(post => post.endpoint === '/call')!.body).toEqual({ tool: 'subagent_list', params: {} })
  })

  test('a wait result carries the drained updates', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    fake.callResult = { text: '1 subagent finished.', isError: false }
    fake.pending = '# Managed subagent finished'
    const waited = await $.tool.call({ tool: 'mcp__pi-bridge__subagent_wait_for_any', timeout_seconds: 5 })
    expect(waited.result).toBe('1 subagent finished.\n\n# Managed subagent finished')
    expect(fake.posts.find(post => post.endpoint === '/call')!.body.params).toEqual({ timeout_seconds: 5 })
  })

  test('a tool error reaches the model as an error', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    fake.callResult = { text: 'Unknown subagent ID', isError: true }
    const failed = await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    expect(failed.deny).toContain('Unknown subagent ID')
  })

  test('an idle session gets drained updates as a prompt', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    fake.pending = '# Managed subagent finished'
    await fake.clock.advance(2500)
    expect(fake.submitted).toEqual(['# Managed subagent finished'])
  })

  test('a long call polls its job until the result', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    fake.jobs = 3
    const waited = await $.tool.call({ tool: 'mcp__pi-bridge__subagent_wait_for_any', timeout_seconds: 300 })
    expect(waited.result).toBe('ok')
    expect(fake.posts.filter(post => post.endpoint === '/job').map(post => post.body)).toEqual([{ id: 'job-1' }, { id: 'job-1' }, { id: 'job-1' }])
  })

  test('a failed call to a live hub is not sent twice', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    fake.isCallFailing = true
    const failed = await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    expect(failed.deny).toContain('Pi hub error')
    expect(fake.posts.filter(post => post.endpoint === '/call')).toHaveLength(1)
    expect(fake.runs.filter(argv => argv.includes('ensure'))).toHaveLength(1)
  })

  test('a prompt typed during a turn ends a running wait', async ($, on) => {
    const fake = fakeWorld(on)
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    await $.prompt.submit({ text: 'stop waiting', turnId: 'turn-1', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'next task', wait: false, origin: { kind: 'composer' } })
    expect(fake.posts.filter(post => post.endpoint === '/interrupt')).toHaveLength(1)
  })

  test('the band draws the widget lines in theme colors and turns the spinners', async ($, on) => {
    const fake = fakeWorld(on)
    fake.lines = LINES
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    await fake.clock.advance(1000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'pi-bridge', surface, ...BAND })
      const title = await ui.find({ type: 'Text', text: /^Subagents$/, in: 'tree' })
      expect(title?.props).toMatchObject({ color: 'claude', bold: true })
      expect((await ui.find({ type: 'Text', text: /^ running$/, in: 'tree' }))?.props.color).toBe('claude')
      expect(await ui.find({ type: 'Text', text: /^·$/, in: 'tree' })).toBeDefined()
      await ui.advance(240)
      expect(await ui.find({ type: 'Text', text: /^·$/, in: 'tree' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^\*$/, in: 'tree' })).toBeDefined()
      await ui.unmount()
    }
    // The hub lays the table out to the band's width.
    await fake.clock.advance(1000)
    expect(fake.posts.filter(post => post.endpoint === '/state').at(-1)!.body).toEqual({ width: 100 })
  })

  test('the band stays empty without agents', async ($, on) => {
    const fake = fakeWorld(on)
    // The engine's own band.
    on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
    await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__pi-bridge__subagent_list' })
    await fake.clock.advance(1000)
    const ui = await $.ui.mount({ plugin: 'pi-bridge', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
  })
})
