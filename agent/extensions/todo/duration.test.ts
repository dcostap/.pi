import { describe, expect, test } from "bun:test";
import { formatRemaining, parseDuration } from "./duration.ts";

describe("todo durations", () => {
	test("parses supported units", () => {
		expect(parseDuration("30s")).toEqual({ text: "30s", milliseconds: 30_000 });
		expect(parseDuration("10m").milliseconds).toBe(600_000);
		expect(parseDuration("2h").milliseconds).toBe(7_200_000);
		expect(parseDuration("1d").milliseconds).toBe(86_400_000);
	});

	test("rejects unsafe intervals", () => {
		expect(() => parseDuration("5s")).toThrow("at least 10 seconds");
		expect(() => parseDuration("every hour")).toThrow("Interval must use");
	});

	test("formats time until a reminder", () => {
		expect(formatRemaining(0)).toBe("due");
		expect(formatRemaining(9_500)).toBe("10s");
		expect(formatRemaining(61_000)).toBe("2m");
	});
});
