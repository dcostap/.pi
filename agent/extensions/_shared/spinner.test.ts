import { describe, expect, test } from "bun:test";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, spinnerFrame } from "./spinner.ts";

describe("shared spinner", () => {
	test("uses the requested six-frame sequence", () => {
		expect(SPINNER_FRAMES.length).toBe(6);
		expect(SPINNER_FRAMES[0]).toBe("·");
		expect(SPINNER_FRAMES[1]).toBe("✢");
		expect(SPINNER_FRAMES[2]).toBe(process.platform === "darwin" ? "✳" : "*");
		expect(SPINNER_FRAMES[3]).toBe("✶");
		expect(SPINNER_FRAMES[4]).toBe("✻");
		expect(SPINNER_FRAMES[5]).toBe("✽");
	});

	test("advances every 120 ms and wraps after one cycle", () => {
		expect(SPINNER_INTERVAL_MS).toBe(120);
		expect(spinnerFrame(0, false)).toBe(SPINNER_FRAMES[0]);
		expect(spinnerFrame(119, false)).toBe(SPINNER_FRAMES[0]);
		expect(spinnerFrame(120, false)).toBe(SPINNER_FRAMES[1]);
		expect(spinnerFrame(720, false)).toBe(SPINNER_FRAMES[0]);
	});

	test("keeps the first character when reduced motion is enabled", () => {
		expect(spinnerFrame(120, true)).toBe("·");
		expect(spinnerFrame(720, true)).toBe("·");
	});
});
