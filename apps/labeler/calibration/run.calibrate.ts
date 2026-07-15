/**
 * Calibration sweep entrypoint (plan W8.6). Invoked via the standalone Node
 * vitest config, not the deterministic suite. Records model outcomes as
 * artifacts; model errors are recorded as data, so this only fails if the
 * sweep produced nothing (missing credentials, no fixtures).
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CALIBRATE_LABEL=baseline \
 *     pnpm --filter @emdash-cms/labeler calibrate
 */

import { expect, test } from "vitest";

import { runCalibration } from "./run.js";

test("calibration sweep", async () => {
	const label = process.env.CALIBRATE_LABEL?.trim() || "run";
	const run = await runCalibration(label);
	expect(run.records.length).toBeGreaterThan(0);
});
