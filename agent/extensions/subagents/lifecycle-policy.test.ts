import { describe, expect, test } from "bun:test";
import { managedSettlementAction } from "./lifecycle-policy.ts";

describe("managed coordinator settlement", () => {
	test("parks natural settlement while child work remains", () => {
		expect(managedSettlementAction(false, true)).toBe("park");
	});

	test("completes after child work clears", () => {
		expect(managedSettlementAction(false, false)).toBe("complete");
	});

	test("lets explicit stop terminate a parked subtree", () => {
		expect(managedSettlementAction(true, true)).toBe("complete");
	});
});
