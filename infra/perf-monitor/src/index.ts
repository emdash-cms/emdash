/**
 * Perf monitor coordinator Worker.
 *
 * Two triggers:
 * - Queue consumer: fires on every `build.succeeded` event from Cloudflare's event
 *   subscriptions. We filter for the demo Worker and run measurements tagged with
 *   the deploy's commit SHA. This is the primary deploy-attribution path.
 * - Cron (every 30 min): ambient baseline. Runs untagged; fills gaps between deploys
 *   and catches drift the queue might miss (subscription downtime, DLQ, etc).
 *
 * HTTP endpoints are read-only: JSON API at /api/* and the static dashboard at /.
 */

import type { MeasureResponse } from "../probe/src/measure.js";
import { handleApi } from "./api.js";
import type { PerfQueueMessage } from "./events.js";
import { isBuildSucceeded } from "./events.js";
import { resolvePrForSha } from "./github.js";
import { DEMO_WORKER_NAME, REGIONS, TARGET_URL, TARGET_ROUTES, WARM_REQUESTS } from "./routes.js";
import type { Region } from "./routes.js";
import { insertResults } from "./store.js";
import type { InsertParams } from "./store.js";

export type MeasurementSource = "deploy" | "cron";

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

/** Dispatch measurements to all regional probes in parallel. */
async function runMeasurements(
	env: Env,
	source: MeasurementSource,
	sha: string | null,
	prNumber: number | null,
): Promise<InsertParams[]> {
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

/**
 * Handle a single build-succeeded event: filter for the demo Worker, resolve
 * the PR number via GitHub, run measurements, persist. Errors are swallowed
 * so one bad message doesn't poison the batch.
 */
async function handleBuildSucceeded(
	env: Env,
	event: Extract<PerfQueueMessage, { type: "cf.workersBuilds.worker.build.succeeded" }>,
): Promise<void> {
	const workerName = event.source.workerName;
	if (workerName !== DEMO_WORKER_NAME) {
		// Not our demo -- ignore.
		return;
	}

	const meta = event.payload.buildTriggerMetadata;
	if (meta.branch !== "main") {
		// Only measure main-branch deploys.
		return;
	}

	const sha = meta.commitHash;
	if (!sha) {
		console.warn("build.succeeded event missing commitHash; skipping");
		return;
	}

	console.log(`Running deploy-triggered measurement for ${workerName} @ ${sha.slice(0, 7)}`);

	const prNumber = await resolvePrForSha(sha);
	const results = await runMeasurements(env, "deploy", sha, prNumber);

	if (results.length > 0) {
		await insertResults(env.DB, results);
		console.log(
			`Stored ${results.length} deploy measurements for ${sha.slice(0, 7)}${prNumber ? ` (PR #${prNumber})` : ""}`,
		);
	} else {
		console.warn(`No measurements returned for ${sha.slice(0, 7)}`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		const apiResponse = await handleApi(request, url, env);
		if (apiResponse) return apiResponse;

		// Anything else falls through to Workers Assets for the dashboard.
		return new Response("Not found", { status: 404 });
	},

	async scheduled(
		controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		console.log(`Cron triggered at ${new Date(controller.scheduledTime).toISOString()}`);

		const results = await runMeasurements(env, "cron", null, null);

		if (results.length > 0) {
			await insertResults(env.DB, results);
			console.log(`Stored ${results.length} cron measurements`);
		} else {
			console.warn("No measurements returned from probes");
		}
	},

	async queue(batch: MessageBatch<PerfQueueMessage>, env: Env): Promise<void> {
		// Messages are processed sequentially to avoid hammering the demo with
		// parallel measurement runs (each one issues N requests per region).
		// A batch of deploy events for different Workers is rare but possible.
		for (const message of batch.messages) {
			try {
				const event = message.body;
				if (!isBuildSucceeded(event)) {
					// Event type we don't care about (build.started, build.failed, etc).
					// Ack silently.
					message.ack();
					continue;
				}
				await handleBuildSucceeded(env, event);
				message.ack();
			} catch (err) {
				console.error("Failed to process queue message:", err);
				// Retry -- exhausted retries send to the DLQ configured in wrangler.jsonc.
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, PerfQueueMessage>;
