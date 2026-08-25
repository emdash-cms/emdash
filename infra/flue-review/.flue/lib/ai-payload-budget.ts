import type { CloudflareAIBinding } from "@flue/runtime/cloudflare";

import { utf8ByteLength } from "./byte-budget.js";

export const MAX_AI_PAYLOAD_BYTES = 1024 * 1024;

export class ModelPayloadTooLargeError extends Error {
	constructor(bytes: number, maxBytes: number) {
		super(
			`Review context is ${bytes} bytes, exceeding the ${maxBytes}-byte model-request budget. Narrow the review context or split the pull request.`,
		);
		this.name = "ModelPayloadTooLargeError";
	}
}

export function createAiPayloadGuard(
	binding: CloudflareAIBinding,
	maxBytes = MAX_AI_PAYLOAD_BYTES,
): CloudflareAIBinding {
	return {
		async run(modelId, inputs, options) {
			const bytes = utf8ByteLength(JSON.stringify(inputs));
			if (bytes > maxBytes) throw new ModelPayloadTooLargeError(bytes, maxBytes);
			return binding.run(modelId, inputs, options);
		},
	};
}
