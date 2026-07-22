import { CDP } from "./protocol.ts";

export type AxFormatResult = {
  text: string;
  lines: string[];
  totalNodes: number;
  shownNodes: number;
  skippedNodes: number;
};

function shouldShowAxNode(node: any, compact: boolean): boolean {
  const role = node.role?.value || "";
  const name = node.name?.value ?? "";
  const value = node.value?.value;
  if (compact && role === "InlineTextBox") return false;
  return role !== "none" && role !== "generic" && !(name === "" && (value === "" || value == null));
}

function formatAxNode(node: any, depth: number): string {
  const role = node.role?.value || "";
  const name = node.name?.value ?? "";
  const value = node.value?.value;
  const states: string[] = [];
  if (node.disabled?.value) states.push("disabled");
  if (node.focused?.value) states.push("focused");
  if (node.expanded?.value != null) states.push(node.expanded.value ? "expanded" : "collapsed");
  if (node.checked?.value != null) states.push(`checked=${node.checked.value}`);
  let line = `${"  ".repeat(Math.min(depth, 20))}[${role}]`;
  if (name !== "") line += ` ${name}`;
  if (!(value === "" || value == null)) line += ` = ${JSON.stringify(value)}`;
  if (states.length) line += ` (${states.join(", ")})`;
  return line;
}

function orderedChildren(node: any, nodesById: Map<string, any>, childrenByParent: Map<string, any[]>): any[] {
  const children: any[] = [];
  const seen = new Set<string>();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

export function formatAxTree(nodes: any[], compact = true): AxFormatResult {
  const nodesById = new Map<string, any>(nodes.map((node) => [node.nodeId, node]));
  const childrenByParent = new Map<string, any[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId)!.push(node);
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  let skippedNodes = 0;
  const visit = (node: any, depth: number) => {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const shown = shouldShowAxNode(node, compact);
    if (shown) lines.push(formatAxNode(node, depth));
    else skippedNodes++;
    const childDepth = shown ? depth + 1 : depth;
    for (const child of orderedChildren(node, nodesById, childrenByParent)) visit(child, childDepth);
  };

  const roots = nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  const header = `${lines.length} accessible nodes (${nodes.length} AX nodes, ${skippedNodes} skipped)`;
  return {
    text: `${header}\n${lines.join("\n")}`,
    lines,
    totalNodes: nodes.length,
    shownNodes: lines.length,
    skippedNodes,
  };
}

export async function getAxTree(cdp: CDP, sessionId: string, timeoutMs: number, signal?: AbortSignal, compact = true): Promise<AxFormatResult> {
  await cdp.send("Accessibility.enable", {}, sessionId, timeoutMs, signal);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId, timeoutMs, signal);
  return formatAxTree(nodes || [], compact);
}
