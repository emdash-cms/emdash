// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { runSeed } from "./harness.js";

const SEEDS = Number(process.env.ROOM_SEEDS ?? 1000);

describe("room convergence harness", () => {
	it(`converges over ${SEEDS} fixed seeds`, { timeout: 0 }, async () => {
		const failed: string[] = [];
		for (let seed = 1; seed <= SEEDS; seed++) {
			const result = await runSeed(seed);
			if (result.failures.length === 0) continue;
			failed.push(`seed ${seed}: ${result.failures.join("; ")}`);
			console.error(
				`[room harness] seed ${seed} failed:\n  ${result.failures.join("\n  ")}\n  events: ${result.events.slice(-40).join(" ")}`,
			);
			if (failed.length >= 5) break;
		}
		expect(failed).toEqual([]);
	});
});
