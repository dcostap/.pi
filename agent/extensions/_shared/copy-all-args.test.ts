import { describe, expect, test } from "bun:test";
import { parseMessageLimit } from "../copy-all.ts";

describe("parseMessageLimit", () => {
  test("treats an omitted argument as unlimited", () => {
    expect(parseMessageLimit("")).toBeUndefined();
    expect(parseMessageLimit("   ")).toBeUndefined();
  });

  test("accepts one positive integer", () => {
    expect(parseMessageLimit("2")).toBe(2);
    expect(parseMessageLimit(" 12 ")).toBe(12);
  });

  test("rejects invalid limits and extra arguments", () => {
    expect(parseMessageLimit("0")).toBeNull();
    expect(parseMessageLimit("-2")).toBeNull();
    expect(parseMessageLimit("2 3")).toBeNull();
    expect(parseMessageLimit("9007199254740992")).toBeNull();
  });
});
