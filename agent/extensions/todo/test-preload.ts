import { mock } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES: 50 * 1024,
	DEFAULT_MAX_LINES: 2000,
}));
