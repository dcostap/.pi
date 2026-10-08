export type Tree = string | null

declare module 'claude-code' {
  interface PluginState {
    'pi-bridge': { tree: Tree }
  }
}
