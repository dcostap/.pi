import { mock } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum(values: readonly string[], options: Record<string, unknown> = {}) {
    return { type: "string", enum: [...values], ...options };
  },
}));

const Type = {
  Object(properties: Record<string, unknown>, options: Record<string, unknown> = {}) { return { type: "object", properties, ...options }; },
  Optional(schema: unknown) { return schema; },
  String(options: Record<string, unknown> = {}) { return { type: "string", ...options }; },
  Number(options: Record<string, unknown> = {}) { return { type: "number", ...options }; },
  Boolean(options: Record<string, unknown> = {}) { return { type: "boolean", ...options }; },
  Any(options: Record<string, unknown> = {}) { return { ...options }; },
  Array(items: unknown, options: Record<string, unknown> = {}) { return { type: "array", items, ...options }; },
  Record(_key: unknown, value: unknown, options: Record<string, unknown> = {}) { return { type: "object", additionalProperties: value, ...options }; },
};
mock.module("typebox", () => ({ Type }));

mock.module("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(public text: string, public paddingX = 0, public paddingY = 0) {}
    setText(text: string) { this.text = text; }
    render() { return this.text.split("\n"); }
    invalidate() {}
  },
}));
