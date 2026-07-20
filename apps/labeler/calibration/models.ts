/**
 * Model matrix under evaluation (plan W8.6). Data-driven so models can be
 * added or removed without touching the runner. Each entry names the Workers
 * AI model id and the lanes it participates in.
 *
 * Verified enabled on the account this session. `llama-3.2-11b-vision` needs a
 * one-time license acceptance; the runner surfaces the license-gate error as a
 * clear instruction rather than auto-agreeing.
 */

export type CalibrationLane = "code" | "image";

export interface CalibrationModel {
	readonly modelId: string;
	readonly lanes: readonly CalibrationLane[];
	/** True for reasoning models that spend output tokens on `reasoning_content`
	 * before `content`; recorded so truncation (empty content, finish_reason
	 * "length") is diagnosable in the run artifact. */
	readonly reasoning?: boolean;
	readonly note?: string;
}

// Ordered slowest-first (observed latency): the sweep runs models in this order,
// so a wall-clock kill costs the cheapest, fastest-to-redo calls at the tail
// rather than the expensive reasoning-model data captured up front.
export const MODELS: readonly CalibrationModel[] = [
	{ modelId: "@cf/moonshotai/kimi-k2.7-code", lanes: ["code", "image"] },
	{ modelId: "@cf/zai-org/glm-5.2", lanes: ["code"] },
	{
		modelId: "@cf/meta/llama-3.2-11b-vision-instruct",
		lanes: ["image"],
		note: "needs one-time license acceptance",
	},
];

export function modelsForLane(lane: CalibrationLane): readonly CalibrationModel[] {
	return MODELS.filter((model) => model.lanes.includes(lane));
}
