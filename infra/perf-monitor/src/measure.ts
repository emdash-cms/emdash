/** Orchestrates a measurement run across all regional probes. */

import type { MeasureResponse } from "../probe/src/measure.js";
import { REGIONS, TARGET_URL, TARGET_ROUTES, WARM_REQUESTS } from "./routes.js";
import type { Region } from "./routes.js";
import type { InsertParams, Source } from "./store.js";

const PROBE_BINDINGS: Record<
	Region,
	keyof Pick<Env, "PROBE_USE" | "PROBE_EUW" | "PROBE_APE" | "PROBE_APS">
> = {
	use: "PROBE_USE",
	euw: "PROBE_EUW",
	ape: "PROBE_APE",
	aps: "PROBE_APS",
};

function generateId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Options for {@link runMeasurements} beyond the source tag. */
export interface RunOptions {
	source: Source;
	sha?: string | null;
	prNumber?: number | null;
	note?: string | null;
}

/** Dispatch measurements to all regional probes in parallel. */
export async function runMeasurements(env: Env, opts: RunOptions): Promise<InsertParams[]> {
	const { source, sha = null, prNumber = null, note = null } = opts;
	const payload = {
		targetUrl: TARGET_URL,
		routes: TARGET_ROUTES.map((r) => ({ path: r.path, label: r.label })),
		warmRequests: WARM_REQUESTS,
	};

	// Dispatch to all probes in parallel
	const probePromises = REGIONS.map(async (region) => {
		const binding = PROBE_BINDINGS[region];
		const probe = env[binding];

		try {
			const response = await probe.fetch("https://probe/measure", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...payload, region }),
			});

			if (!response.ok) {
				const errText = await response.text();
				console.error(`Probe ${region} failed: ${response.status} ${errText}`);
				return [];
			}

			const data = await response.json<MeasureResponse>();

			return data.results.map(
				(r): InsertParams => ({
					id: generateId(),
					sha,
					prNumber,
					route: r.path,
					region,
					coldTtfbMs: r.coldTtfbMs,
					warmTtfbMs: r.warmTtfbMs,
					p95TtfbMs: r.p95TtfbMs,
					statusCode: r.statusCode,
					cfColo: r.cfColo,
					cfPlacement: r.cfPlacement,
					coldServerTimings: r.coldServerTimings,
					warmServerTimings: r.warmServerTimings,
					note,
					source,
				}),
			);
		} catch (err) {
			console.error(`Probe ${region} error:`, err);
			return [];
		}
	});

	const allResults = await Promise.all(probePromises);
	return allResults.flat();
}
