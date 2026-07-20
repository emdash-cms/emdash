/**
 * Calibration report entrypoint (plan W8.6). Reads one run dir (and optionally
 * a baseline run dir) and writes a markdown report into the run dir.
 *
 *   CALIBRATE_RUN=calibration/runs/<ts>-<label> \
 *     [CALIBRATE_BASE=calibration/runs/<ts>-<baseline>] \
 *     pnpm --filter @emdash-cms/labeler calibrate:report
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { loadRun } from "./io.js";
import { renderReport } from "./report.js";

test("calibration report", () => {
	const runDir = process.env.CALIBRATE_RUN?.trim();
	if (!runDir)
		throw new Error(
			"set CALIBRATE_RUN=<run dir> (and optionally CALIBRATE_BASE=<baseline run dir>)",
		);
	const run = loadRun(runDir);
	const baseDir = process.env.CALIBRATE_BASE?.trim();
	const base = baseDir ? loadRun(baseDir) : undefined;
	const markdown = renderReport(run, base);
	const outFile = join(runDir, base ? "report-vs-base.md" : "report.md");
	writeFileSync(outFile, `${markdown}\n`);
	console.info(`[calibration] wrote report to ${outFile}`);
	expect(markdown.length).toBeGreaterThan(0);
});
