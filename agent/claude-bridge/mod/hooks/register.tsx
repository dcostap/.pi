// pi-bridge: Pi subagents for Claude Code, and Pi mirrors of Claude Code sessions.
//
// The tools call a headless Pi hub (../hub/hub.ts) that runs the subagents
// extension. The hub starts on the first tool call. When the session is idle,
// the mod pulls batched subagent updates from the hub and submits them as a
// prompt, as Pi does at agent_settled. After each main turn, the mod rebuilds
// the Pi mirror of this session (../mirror/sync.ts).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tree } from '../types'

const PREFIX = 'mcp__pi-bridge__'
const TICK_MS = 2000
const WAIT_TOOL = 'subagent_wait_for_any'
const tree = atom({ plugin: 'pi-bridge', key: 'tree' } as const, null)

type Hub = { port: number; token: string; session: string }
type ToolSpecs = { tools: { name: string; description: string; parameters: Record<string, unknown> }[]; instructions: string }
type State = {
  hub?: Hub
  starting?: Promise<Hub>
  instructions: string
  isBusy: boolean
  isTicking: boolean
  hasTimer: boolean
  isMirrorDirty: boolean
  mirror?: Promise<void>
  lastTree: Tree
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function bun($: EngineInterface, relativeScript: string, args: string[], timeoutMs: number): Promise<string> {
  const ran = await $.process.run(['bun', `${$.plugin.root}/../${relativeScript}`, ...args], { timeoutMs })
  if (ran.exitCode !== 0) throw new Error((ran.stderr || ran.stdout).trim() || `bun exited with ${ran.exitCode}`)
  return ran.stdout
}

async function ensureHub($: EngineInterface, s: State): Promise<Hub> {
  const session = await $.session.id()
  const cwd = await $.session.cwd()
  const out = await bun($, 'hub/hub.ts', ['ensure', '--session', session, '--cwd', cwd], 90_000)
  s.hub = { ...JSON.parse(out.trim().split('\n').pop()!), session }
  return s.hub!
}

function startHub($: EngineInterface, s: State): Promise<Hub> {
  s.starting ??= ensureHub($, s).finally(() => {
    s.starting = undefined
  })
  return s.starting
}

async function fetchHub($: EngineInterface, hub: Hub, endpoint: string, body: unknown): Promise<any> {
  const response = await $.http.fetch(`http://127.0.0.1:${hub.port}${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Pi hub ${endpoint} failed: HTTP ${response.status} ${response.text}`)
  return JSON.parse(response.text)
}

async function isAlive($: EngineInterface, hub: Hub): Promise<boolean> {
  try {
    await fetchHub($, hub, '/ping', {})
    return true
  } catch {
    return false
  }
}

// Posts to the hub. With `start`, a missing hub is started, and a hub that
// stopped (idle timeout or crash) is started again once. Its agents restore.
async function post($: EngineInterface, s: State, endpoint: string, body: unknown, start: boolean): Promise<any> {
  const session = await $.session.id()
  if (s.hub && s.hub.session !== session) s.hub = undefined
  for (let attempt = 0; ; attempt++) {
    const hub = s.hub ?? (start ? await startHub($, s) : undefined)
    if (!hub) return undefined
    try {
      return await fetchHub($, hub, endpoint, body)
    } catch (error) {
      // Send again only when the hub is gone. A live hub may have run the call.
      if (await isAlive($, hub)) throw error
      s.hub = undefined
      if (!start || attempt > 0) throw error
    }
  }
}

async function runMirror($: EngineInterface, sessionId: string): Promise<void> {
  try {
    await bun($, 'mirror/sync.ts', ['session', sessionId], 120_000)
  } catch (error) {
    $.ui.log(`pi-bridge: mirror sync failed: ${message(error)}`)
  }
}

async function syncMirror($: EngineInterface, s: State): Promise<void> {
  if (s.mirror) return
  s.isMirrorDirty = false
  s.mirror = runMirror($, await $.session.id()).finally(() => {
    s.mirror = undefined
  })
}

async function showTree($: EngineInterface, s: State, text: Tree): Promise<void> {
  if (text === s.lastTree) return
  s.lastTree = text
  await update($, tree, () => text)
}

// Runs every TICK_MS: mirror sync, the band, and idle delivery.
async function tick($: EngineInterface, s: State): Promise<void> {
  if (s.isTicking) return
  s.isTicking = true
  try {
    if (s.isMirrorDirty) await syncMirror($, s)
    if (!s.hub) return void (await showTree($, s, null))
    const state = await post($, s, '/state', {}, false)
    await showTree($, s, state?.text ?? null)
    if (s.isBusy) return
    const drained = await post($, s, '/drain', {}, false)
    if (!drained?.text) return
    s.isBusy = true
    const submitted = await $.prompt.submit({ text: drained.text })
    if ('drop' in submitted) s.isBusy = false
  } catch {
    // A failed poll is retried on the next tick.
  } finally {
    s.isTicking = false
  }
}

async function registerTools($: EngineInterface, s: State): Promise<void> {
  try {
    const specs: ToolSpecs = JSON.parse(await bun($, 'hub/hub.ts', ['tools'], 90_000))
    s.instructions = specs.instructions
    for (const tool of specs.tools) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.parameters })
    }
  } catch (error) {
    $.ui.log(`pi-bridge: Pi subagent tools are not available: ${message(error)}`)
  }
}

async function interrupt($: EngineInterface, s: State): Promise<void> {
  await post($, s, '/interrupt', {}, false).catch(() => {})
}

async function callTool($: EngineInterface, s: State, name: string, params: Record<string, unknown>) {
  try {
    let called = await post($, s, '/call', { tool: name, params }, true)
    // A long call (a wait) answers a job; ask again until it ends.
    while (called?.pending) called = await post($, s, '/job', { id: called.pending }, false)
    if (!called) throw new Error('The Pi hub stopped during the call.')
    let text: string = called.text
    if (name === WAIT_TOOL && !called.isError) {
      const drained = await post($, s, '/drain', {}, false)
      if (drained?.text) text += `\n\n${drained.text}`
    }
    void tick($, s)
    return called.isError ? { deny: text } : { result: text }
  } catch (error) {
    return { deny: `Pi hub error: ${message(error)}` }
  }
}

async function endSession($: EngineInterface, s: State, sessionId: string): Promise<void> {
  await Promise.all([
    post($, s, '/shutdown', {}, false).catch(() => {}),
    (s.mirror ?? Promise.resolve()).then(() => runMirror($, sessionId)),
  ])
}

export const register: Register = on => {
  const s: State = { instructions: '', isBusy: false, isTicking: false, hasTimer: false, isMirrorDirty: false, lastTree: null }

  on('session.start', async ($, e, next) => {
    await registerTools($, s)
    // /clear starts a new session in the same load. Keep one timer.
    if (!s.hasTimer) $.clock.every(TICK_MS, () => void tick($, s))
    s.hasTimer = true
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!s.instructions) return composed
    const text = [
      'Pi subagents (pi-bridge): the mcp__pi-bridge__subagent_* tools run managed Pi subagents on any model that Pi can use.',
      'When the user asks for subagents, use these tools, not the Agent tool, unless the user asks for Claude subagents.',
      'In the rules below, "Pi" is the subagent runtime and tool names omit the mcp__pi-bridge__ prefix.',
      'Subagent updates arrive as a new user message when you are idle. Do not poll for them.',
      '',
      s.instructions,
    ].join('\n')
    return { ...composed, sections: [...composed.sections, { id: 'pi-bridge:subagents', text, scope: 'session' as const }] }
  })

  on('tool.call', { tool: /^mcp__pi-bridge__/ }, async ($, e, next) => {
    const { tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...params } = e as Record<string, unknown>
    // Escape ends a running wait, as a Pi steering message does.
    const onAbort = () => void interrupt($, s)
    next.signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await callTool($, s, String(tool).slice(PREFIX.length), params)
    } finally {
      next.signal.removeEventListener('abort', onAbort)
    }
  })

  // A prompt typed during a turn ends a running wait, as a Pi steering message does.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId && s.hub) void interrupt($, s)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    s.isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      s.isBusy = false
      s.isMirrorDirty = true
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await endSession($, s, e.sessionId)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, tree)
    if (!text || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const lines = text.split('\n')
    const room = Math.max(3, Math.min(12, e.props.maxRows - 1))
    const shown = lines.length > room ? [...lines.slice(0, room - 1), `… ${lines.length - room + 1} more lines`] : lines
    return (
      <Box flexDirection="column">
        <Text dimColor>Pi subagents</Text>
        {shown.map((line, index) => <Text key={String(index)} wrap="truncate-end">{line}</Text>)}
      </Box>
    )
  })
}
