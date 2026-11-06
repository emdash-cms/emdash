import type { WorkersAiBinding } from "../src/ai/workers-ai.js";

export interface RawProviderResponse {
	model: string;
	attempt: number;
	status: number;
	input: Record<string, unknown>;
	output: unknown;
}

export interface RemoteSweepBindingOptions {
	maxDimension?: number;
	onResponse?: (response: RawProviderResponse) => void;
	fetch?: typeof globalThis.fetch;
}

export function createRemoteSweepBinding(
	url: string,
	options: RemoteSweepBindingOptions = {},
): WorkersAiBinding {
	const fetch = options.fetch ?? globalThis.fetch;
	return {
		async run(model, input, providerOptions) {
			const retryDelays = [250, 1_000, 3_000] as const;
			for (let attempt = 0; ; attempt += 1) {
				const response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model,
						input,
						...(options.maxDimension === undefined
							? {}
							: { imageMaxDimension: options.maxDimension }),
					}),
					signal: providerOptions?.signal,
				});
				const value: unknown = await response.json();
				options.onResponse?.({
					model,
					attempt: attempt + 1,
					status: response.status,
					input,
					output: value,
				});
				if (response.ok) return value;
				const delay = retryDelays[attempt];
				if ((response.status === 429 || response.status >= 500) && delay !== undefined) {
					await waitForRetry(delay, providerOptions?.signal);
					continue;
				}
				const message =
					typeof value === "object" && value !== null && "error" in value
						? String(value.error)
						: `HTTP ${response.status}`;
				throw new Error(message);
			}
		},
	};
}

async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await new Promise((done) => setTimeout(done, delay));
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, delay);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
