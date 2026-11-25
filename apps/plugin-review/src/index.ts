import { WorkerEntrypoint } from "cloudflare:workers";

import { runReview } from "./agent.js";
import { gatewayReviewModel, type GatewayEnv } from "./models.js";
import { parseRequest } from "./request.js";
import type { PluginReviewResponse } from "./types.js";

const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

interface ReviewEnv extends GatewayEnv {
	/** Private guidance appended to the public prompt, for example during an embargo. */
	readonly PLUGIN_REVIEW_PROMPT_ADDENDUM?: string;
}

/**
 * Reviews one plugin release with one model. Reached only over a service
 * binding from the labeler; it has no public routes.
 */
export default class PluginReview extends WorkerEntrypoint<ReviewEnv> {
	override async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	}

	async review(value: unknown): Promise<PluginReviewResponse> {
		const request = parseRequest(value);
		const model = gatewayReviewModel(this.env, request.model);
		return runReview(request, model, {
			...(this.env.PLUGIN_REVIEW_PROMPT_ADDENDUM
				? { addendum: this.env.PLUGIN_REVIEW_PROMPT_ADDENDUM }
				: {}),
			signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
		});
	}
}
