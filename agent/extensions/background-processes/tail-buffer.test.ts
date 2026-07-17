import { describe, expect, test } from "bun:test";
import { TailBuffer } from "./tail-buffer.ts";

describe("TailBuffer", () => {
	test("starts empty", () => {
		expect(new TailBuffer(8).snapshot()).toEqual({
			text: "",
			totalBytes: 0,
			retainedBytes: 0,
			droppedBytes: 0,
			truncated: false,
			version: 0,
		});
	});

	test("retains several chunks up to the exact cap", () => {
		const tail = new TailBuffer(6);
		tail.append(Buffer.from("ab"));
		tail.append(Buffer.from("cdef"));
		expect(tail.snapshot()).toMatchObject({ text: "abcdef", retainedBytes: 6, droppedBytes: 0, version: 2 });
	});

	test("evicts only the oldest bytes", () => {
		const tail = new TailBuffer(5);
		tail.append(Buffer.from("abc"));
		tail.append(Buffer.from("defg"));
		expect(tail.snapshot()).toMatchObject({ text: "cdefg", totalBytes: 7, retainedBytes: 5, droppedBytes: 2 });
	});

	test("handles a chunk larger than the cap", () => {
		const tail = new TailBuffer(4);
		tail.append(Buffer.from("old"));
		tail.append(Buffer.from("123456789"));
		expect(tail.snapshot()).toMatchObject({ text: "6789", totalBytes: 12, retainedBytes: 4, droppedBytes: 8 });
	});

	test("decodes multibyte data split across chunks", () => {
		const bytes = Buffer.from("A😀B");
		const tail = new TailBuffer(32);
		tail.append(bytes.subarray(0, 3));
		tail.append(bytes.subarray(3));
		expect(tail.snapshot().text).toBe("A😀B");
	});

	test("malformed UTF-8 never throws", () => {
		const tail = new TailBuffer(8);
		tail.append(Buffer.from([0xff, 0xfe, 0x61]));
		expect(() => tail.snapshot()).not.toThrow();
		expect(tail.snapshot().text.endsWith("a")).toBe(true);
	});

	test("retained byte count never exceeds the cap during churn", () => {
		const tail = new TailBuffer(97);
		for (let i = 0; i < 10_000; i++) {
			tail.append(Buffer.alloc((i % 131) + 1, i % 251));
			expect(tail.snapshot().retainedBytes).toBeLessThanOrEqual(97);
		}
	});

	test("retains a bounded tail after 100 MiB of output", () => {
		const cap = 1024 * 1024;
		const tail = new TailBuffer(cap);
		const chunk = Buffer.alloc(64 * 1024, 0x78);
		for (let written = 0; written < 100 * 1024 * 1024; written += chunk.length) tail.append(chunk);
		expect(tail.snapshot()).toMatchObject({
			totalBytes: 100 * 1024 * 1024,
			retainedBytes: cap,
			droppedBytes: 99 * 1024 * 1024,
			truncated: true,
		});
	});
});
