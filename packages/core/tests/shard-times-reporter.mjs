import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes the seconds each test file took to import, set up and run, the
 * measure that shard-times.json holds, to vitest-timings/unit.json.
 */
export default class ShardTimesReporter {
	onInit(vitest) {
		this.root = vitest.config.root;
	}

	onTestRunEnd(testModules) {
		const times = {};
		for (const testModule of testModules) {
			const { collectDuration, setupDuration, duration } = testModule.diagnostic();
			const name = path.relative(this.root, testModule.moduleId).split(path.sep).join("/");
			times[name] = (collectDuration + setupDuration + duration) / 1000;
		}
		const file = path.join(this.root, "vitest-timings", "unit.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(times, null, "\t")}\n`);
	}
}
