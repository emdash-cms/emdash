// Writes the generated machine artifacts to disk. Run with `pnpm bot:generate`
// after editing `.flue/lib/machine.ts`. The rendering lives in
// `machine-artifacts.ts`; this file only handles filesystem I/O so the drift
// test can import the renderers without pulling in node:fs.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateMachine } from "../.flue/lib/machine.ts";
import { renderMachineDoc, renderMachineJson } from "./machine-artifacts.ts";

const problems = validateMachine();
if (problems.length > 0) {
	for (const problem of problems) console.error(`machine.ts: ${problem.message}`);
	process.exit(1);
}

const botRoot = fileURLToPath(new URL("..", import.meta.url).href);

writeFileSync(`${botRoot}.flue/lib/machine.json`, renderMachineJson());
writeFileSync(`${botRoot}BOT_STATE_MACHINE.md`, renderMachineDoc());

console.log("Wrote .flue/lib/machine.json and BOT_STATE_MACHINE.md");
