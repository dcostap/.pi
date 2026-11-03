import { afterEach, describe, expect, test } from "bun:test";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { COPIED_LABEL, COPY_LABEL, FAILED_LABEL, installCodeBlockCopyButton } from "./code-block-copy-button.ts";

const identity = (text: string) => text;
const theme = {
	heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
	codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity, listBullet: identity,
	bold: identity, italic: identity, strikethrough: identity, underline: identity,
};

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

function install(copy?: (text: string) => Promise<void>) {
	const copies: string[] = [];
	const renders = { count: 0 };
	const restore = installCodeBlockCopyButton(
		Markdown,
		copy ?? (async (text) => { copies.push(text); }),
		() => { renders.count++; },
	);
	expect(restore).toBeDefined();
	restores.push(restore!);
	return Object.assign(copies, { renders });
}

const longLine = `robocopy "${"C:\\very\\long\\path\\".repeat(8)}" "D:\\target" /MIR`;
const source = `Before\n\n\`\`\`powershell\n${longLine}\n  /XD .git\n\`\`\`\n\nMiddle\n\n\`\`\`\nsecond block\n\`\`\`\n`;

function click(markdown: Markdown, x: number, y: number, type = "click", button = "left") {
	return (markdown as any).handleMouse({ type, button, x, y });
}

function labelPosition(lines: string[], nth: number) {
	const rows = lines.map((line, row) => ({ row, plain: stripTerminalSequences(line) })).filter((entry) => entry.plain.includes(COPY_LABEL));
	const entry = rows[nth];
	return { row: entry.row, x: entry.plain.indexOf(COPY_LABEL) };
}

describe("code block copy button", () => {
	test("labels each code block", () => {
		install();
		const lines = new Markdown(source, 1, 0, theme as any).render(40);
		expect(lines.filter((line) => stripTerminalSequences(line).includes(COPY_LABEL))).toHaveLength(2);
	});

	test("a click on a label copies the exact source of that block", () => {
		const copies = install();
		const markdown = new Markdown(source, 1, 0, theme as any);
		const lines = markdown.render(40);
		const first = labelPosition(lines, 0);
		const second = labelPosition(lines, 1);
		expect(click(markdown, first.x, first.row, "press")).toEqual({ handled: true });
		expect(copies).toEqual([]);
		expect(click(markdown, first.x + 1, first.row)).toEqual({ handled: true });
		expect(click(markdown, second.x, second.row)).toEqual({ handled: true });
		expect(copies).toEqual([`${longLine}\n  /XD .git`, "second block"]);
	});

	test("the label shows the result of a click, then goes back", async () => {
		const copies = install();
		const markdown = new Markdown(source, 1, 0, theme as any);
		const first = labelPosition(markdown.render(40), 0);
		click(markdown, first.x, first.row);
		await Bun.sleep(20);
		const text = () => markdown.render(40).map((line) => stripTerminalSequences(line));
		expect(text().filter((line) => line.includes(COPIED_LABEL))).toHaveLength(1);
		expect(text().filter((line) => line.includes(COPY_LABEL))).toHaveLength(1);
		expect(markdown.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(copies.renders.count).toBeGreaterThan(0);
		await Bun.sleep(1700);
		expect(text().some((line) => line.includes(COPIED_LABEL))).toBe(false);
		expect(text().filter((line) => line.includes(COPY_LABEL))).toHaveLength(2);
	});

	test("a failed copy shows a failed label", async () => {
		install(async () => { throw new Error("no clipboard"); });
		const markdown = new Markdown(source, 1, 0, theme as any);
		const first = labelPosition(markdown.render(40), 0);
		click(markdown, first.x, first.row);
		await Bun.sleep(20);
		expect(markdown.render(40).some((line) => stripTerminalSequences(line).includes(FAILED_LABEL))).toBe(true);
	});

	test("clicks elsewhere or with another button are ignored", () => {
		const copies = install();
		const markdown = new Markdown(source, 1, 0, theme as any);
		const first = labelPosition(markdown.render(40), 0);
		expect(click(markdown, 0, first.row)).toBeUndefined();
		expect(click(markdown, first.x, first.row + 1)).toBeUndefined();
		expect(click(markdown, first.x, first.row, "click", "right")).toBeUndefined();
		expect(copies).toEqual([]);
	});

	test("a cached render keeps the buttons", () => {
		const copies = install();
		const markdown = new Markdown(source, 1, 0, theme as any);
		markdown.render(40);
		const first = labelPosition(markdown.render(40), 0);
		click(markdown, first.x, first.row);
		expect(copies).toHaveLength(1);
	});

	test("streamed updates keep reused blocks clickable", async () => {
		const copies = install();
		const markdown = new Markdown("```ts\nfirst()\n```\n\nAfter", 1, 0, theme as any);
		markdown.render(40);
		markdown.setText("```ts\nfirst()\n```\n\nAfter streaming\n\n```\nsecond\n```");
		markdown.render(40);
		markdown.setText("```ts\nfirst()\n```\n\nAfter streaming\n\n```\nsecond\n```\n\nDone");
		const lines = markdown.render(40);
		for (let index = 0; index < 2; index++) {
			const position = labelPosition(lines, index);
			expect(click(markdown, position.x, position.row)).toEqual({ handled: true });
		}
		await Bun.sleep(20);
		expect(copies).toEqual(["first()", "second"]);
		expect(markdown.render(40).filter((line) => stripTerminalSequences(line).includes(COPIED_LABEL))).toHaveLength(2);
	});

	test("identical blocks keep separate click targets and feedback", async () => {
		const copies = install();
		const markdown = new Markdown("```\nsame\n```\n\n```\nsame\n```\n\nAfter", 1, 0, theme as any);
		const second = labelPosition(markdown.render(40), 1);
		expect(click(markdown, second.x, second.row)).toEqual({ handled: true });
		await Bun.sleep(20);
		const lines = markdown.render(40);
		expect(copies).toEqual(["same"]);
		expect(lines.filter((line) => stripTerminalSequences(line).includes(COPIED_LABEL))).toHaveLength(1);
		expect(lines.filter((line) => stripTerminalSequences(line).includes(COPY_LABEL))).toHaveLength(1);
	});

	test("streamed updates keep code in quotes and lists clickable", () => {
		const copies = install();
		const nested = "> ```\n> quoted\n> ```\n\n- item\n\n  ```\n  listed\n  ```\n\nAfter";
		const markdown = new Markdown(nested, 1, 0, theme as any);
		markdown.render(40);
		markdown.setText(`${nested} streaming`);
		const lines = markdown.render(40);
		for (let index = 0; index < 2; index++) {
			const position = labelPosition(lines, index);
			expect(click(markdown, position.x, position.row)).toEqual({ handled: true });
		}
		expect(copies).toEqual(["quoted", "listed"]);
	});

	test("restore removes the label and the click handler", () => {
		const restore = installCodeBlockCopyButton(Markdown, async () => {}, () => {});
		restore!();
		const markdown = new Markdown(source, 1, 0, theme as any);
		expect(markdown.render(40).some((line) => stripTerminalSequences(line).includes(COPY_LABEL))).toBe(false);
		expect((markdown as any).handleMouse).toBeUndefined();
	});

	test("refuses a class without the members that it patches", () => {
		expect(installCodeBlockCopyButton(class {}, async () => {}, () => {})).toBeUndefined();
	});
});
