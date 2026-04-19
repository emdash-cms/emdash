/**
 * Perf monitor coordinator Worker.
 *
 * Triggers:
 * - Queue consumer: fires on every `build.succeeded` event from Cloudflare's event
 *   subscriptions. We filter for the demo Worker and run measurements tagged with
 *   the deploy's commit SHA. This is the primary deploy-attribution path.
 * - Cron (every 30 min): ambient baseline. Runs untagged; fills gaps between deploys
 *   and catches drift the queue might miss (subscription downtime, DLQ, etc).
 * - POST /api/trigger: ad-hoc manual measurement, tagged `source=manual`.
 *   Expected to be protected by a Cloudflare Access policy at the edge.
 *
 * HTTP endpoints other than /api/trigger are read-only: JSON API at /api/* and
 * the static dashboard at /.
 */

import { handleApi } from "./api.js";
import type { PerfQueueMessage } from "./events.js";
import { isBuildSucceeded } from "./events.js";
import { resolvePrForSha } from "./github.js";
import { runMeasurements } from "./measure.js";
import { TRIGGER_WORKER_NAME } from "./routes.js";
import { insertResults } from "./store.js";

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
	if (workerName !== TRIGGER_WORKER_NAME) {
		// Not our trigger worker -- ignore. Both demos build from the same
		// commit, so one event covers both sites; measuring on every known
		// worker's event would double our load without adding signal.
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

	const prNumber = await resolvePrForSha(sha, meta.commitMessage);
	const results = await runMeasurements(env, { source: "deploy", sha, prNumber });

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

		const results = await runMeasurements(env, { source: "cron" });

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
