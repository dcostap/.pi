// The Pi subagent tree in the band above the prompt: the lines of Pi's pinned
// widget, drawn in Claude Code theme colors. As a surface module, it animates
// the spinners of running agents on the frame clock, without the hooks module.
import type { ClientElements, ClientModule, ClientSurface } from 'claude-code'

import type { Segment } from '../types'

export type TreeProps = { lines: Segment[][] }

// Pi theme colors to Claude Code theme keys. The hierarchy colors (accent,
// then the thinking colors) tell nesting levels apart.
const COLORS: Record<string, string> = {
  accent: 'claude',
  thinkingLow: 'suggestion',
  thinkingHigh: 'merged',
  thinkingXhigh: 'planMode',
  thinkingMax: 'ide',
  success: 'success',
  error: 'error',
  warning: 'warning',
  toolTitle: 'claude',
  text: 'text',
  muted: 'inactive',
  dim: 'subtle',
}

const SPINNER_FRAMES = ['·', '✢', '*', '✶', '✻', '✽']
// Forward, then back, as Claude Code's own spinner turns.
const SPINNER_CYCLE = [...SPINNER_FRAMES, ...SPINNER_FRAMES.slice(1, -1).reverse()]
const SPINNER_MS = 120

function hasSpinner(lines: Segment[][]): boolean {
  return lines.some(line => line.some(segment => segment.spinner))
}

function drawTree(elements: ClientElements, lines: Segment[][], frame: number) {
  const { Box, Text } = elements
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {lines.map((line, row) => (
        <Text key={String(row)} wrap="truncate-end">
          {line.map((segment, index) => (
            <Text key={String(index)} color={segment.color ? COLORS[segment.color] : undefined} bold={segment.bold}>
              {segment.spinner ? SPINNER_CYCLE[frame % SPINNER_CYCLE.length] : segment.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

// The latest props of each instance, read by its clock.
const latest = new WeakMap<ClientSurface<number>, TreeProps>()

const Tree: ClientModule<TreeProps, number> = (props, surface) => {
  latest.set(surface, props)
  if (surface.state === undefined) {
    surface.setState(0)
    surface.every(SPINNER_MS, () => {
      // Redraw only while an agent runs.
      if (hasSpinner(latest.get(surface)?.lines ?? [])) surface.setState((surface.state ?? 0) + 1)
    })
  }
  return drawTree(surface.elements, props.lines, surface.state ?? 0)
}

export default Tree
