// Drift check for the generated machine artifacts. `.flue/lib/machine.ts` is the
// single source of truth; `machine.json` and `BOT_STATE_MACHINE.md` are
// regenerated from it by `pnpm bot:generate`. These tests fail if the committed
// artifacts fall out of sync, the same contract as the query-count snapshots.

import { describe, expect, test } from "vitest";

import committedMachineJson from "../../.flue/lib/machine.json?raw";
import { validateMachine } from "../../.flue/lib/machine.ts";
import committedMachineDoc from "../../BOT_STATE_MACHINE.md?raw";
import { renderMachineDoc, renderMachineJson } from "../../scripts/machine-artifacts.ts";

describe("machine artifacts", () => {
	test("machine.ts passes structural validation", () => {
		expect(validateMachine()).toEqual([]);
	});

	test("machine.json matches machine.ts (run `pnpm bot:generate`)", () => {
		expect(committedMachineJson).toBe(renderMachineJson());
	});

	test("BOT_STATE_MACHINE.md matches machine.ts (run `pnpm bot:generate`)", () => {
		expect(committedMachineDoc).toBe(renderMachineDoc());
	});
});
