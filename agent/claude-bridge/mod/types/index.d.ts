/** One styled run of a tree line; `color` is a Pi theme color name. */
export type Segment = { text: string; color?: string; bold?: true; spinner?: true }
/** The lines of Pi's subagent widget, or null when the hub knows no agents. */
export type Tree = Segment[][] | null

declare module 'claude-code' {
  interface PluginState {
    'pi-bridge': { tree: Tree }
  }
}
