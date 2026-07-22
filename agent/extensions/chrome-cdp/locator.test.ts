import { describe, expect, test } from "bun:test";
import { buildLocatorExpression, describeLocator, hasLocator, locatorFromParams } from "./locator.ts";

describe("locators", () => {
  test("supports CSS, role, accessible name, text, exactness, and index together", () => {
    const locator = { selector: "button.primary", role: "button", name: "Save", text: "Save now", exact: true, index: 2 };
    const expression = buildLocatorExpression(locator);
    expect(expression).toContain('"selector":"button.primary"');
    expect(expression).toContain('"role":"button"');
    expect(expression).toContain('"name":"Save"');
    expect(expression).toContain('"text":"Save now"');
    expect(expression).toContain('"exact":true');
    expect(expression).toContain('"index":2');
    expect(describeLocator(locator)).toContain('role="button"');
  });

  test("normalizes missing and negative indices", () => {
    expect(buildLocatorExpression({ text: "hello", index: -5 })).toContain('"index":0');
    expect(hasLocator(locatorFromParams({ role: "textbox" }))).toBe(true);
    expect(hasLocator({})).toBe(false);
  });

  test("safely serializes hostile selector text", () => {
    const expression = buildLocatorExpression({ selector: `button\" ); throw new Error('x') //` });
    expect(expression).toContain('\\"');
    expect(expression).toContain("const locator =");
  });
});
