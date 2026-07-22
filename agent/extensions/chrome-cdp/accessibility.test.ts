import { describe, expect, test } from "bun:test";
import { formatAxTree } from "./accessibility.ts";

function node(nodeId: string, role: string, name: string, parentId?: string, childIds?: string[]) {
  return {
    nodeId, parentId, childIds,
    role: { value: role },
    name: { value: name },
    backendDOMNodeId: Number(nodeId.replace(/\D/g, "")) || 1,
  };
}

describe("accessibility tree formatting", () => {
  test("preserves hierarchy and child order", () => {
    const result = formatAxTree([
      node("1", "RootWebArea", "Page", undefined, ["2", "4"]),
      node("2", "navigation", "Main", "1", ["3"]),
      node("3", "button", "Save", "2"),
      node("4", "textbox", "Message", "1"),
    ]);
    expect(result.lines).toEqual([
      "[RootWebArea] Page",
      "  [navigation] Main",
      "    [button] Save",
      "  [textbox] Message",
    ]);
  });

  test("removes generic wrappers without flattening real descendants incorrectly", () => {
    const result = formatAxTree([
      node("1", "RootWebArea", "Page", undefined, ["2"]),
      node("2", "generic", "", "1", ["3"]),
      node("3", "link", "Docs", "2"),
    ]);
    expect(result.lines).toEqual(["[RootWebArea] Page", "  [link] Docs"]);
    expect(result.skippedNodes).toBe(1);
  });
});
