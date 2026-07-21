// Graceful handling for Workers AI capacity (HTTP 429) errors and stalled
// inference calls.
//
// Workers AI returns 429 when a model is over capacity. Under sustained load
// the binding can also hold a request open well past any useful deadline, which
// (without a bound) leaves a review workflow hung forever -- the agent call
// never returns, nothing posts, and the only artifact is the container DO's
// keep-alive alarm firing for minutes. `withCapacityRetry` bounds each attempt
// with a hard timeout (so a stalled call fails loudly instead of hanging) and
// retries genuine capacity errors with exponential backoff + jitter.
//
// `ModelConfig` in @flue/runtime is just a model-id string, so there is no
// provider-level retry/timeout knob to set; this is the application-level
// contract. The wrapped call receives an AbortSignal it must forward to the
// model call (`session.skill(..., { signal })`) for the timeout to take effect.

/** Thrown when every attempt was exhausted by capacity errors. */
export class CapacityExhaustedError extends Error {
	constructor(label: string, attempts: number, cause: unknown) {
		super(`${label}: model over capacity after ${attempts} attempt(s)`, { cause });
		this.name = "CapacityExhaustedError";
	}
}

/** Thrown when a single attempt exceeded its per-attempt timeout. */
export class ModelTimeoutError extends Error {
	constructor(label: string, timeoutMs: number, cause: unknown) {
		super(`${label}: model call exceeded ${timeoutMs}ms timeout`, { cause });
		this.name = "ModelTimeoutError";
	}
}

export interface CapacityRetryOptions {
	/** Human-readable label for logs/errors, e.g. "review" or "classify-reply". */
	label: string;
	/** Total attempts including the first. Default 3. */
	attempts?: number;
	/**
	 * Hard per-attempt deadline. On expiry the attempt is aborted and a
	 * `ModelTimeoutError` is thrown (NOT retried -- a timeout can't be told apart
	 * from slow-but-working progress, so we fail loudly and bounded rather than
	 * burning the full attempt budget). Omit to disable the timeout.
	 */
	perAttemptTimeoutMs?: number;
	/** Base backoff delay. Default 3000ms. */
	baseDelayMs?: number;
	/** Backoff ceiling. Default 30000ms. */
	maxDelayMs?: number;
	/** Caller cancellation, merged with the per-attempt timeout signal. */
	signal?: AbortSignal;
	/** Invoked before each backoff sleep. */
	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const CAPACITY_MARKERS = [
	"429",
	"too many requests",
	"capacity",
	"over capacity",
	"rate limit",
	"overloaded",
	"3040", // Workers AI "Capacity temporarily exceeded" code
];

/** Best-effort classification of a Workers AI / gateway capacity (429) error. */
export function isCapacityError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return CAPACITY_MARKERS.some((marker) => message.includes(marker));
}

function isTimeoutAbort(error: unknown, timeoutSignal: AbortSignal | undefined): boolean {
	if (!timeoutSignal?.aborted) return false;
	return (
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		// Some SDKs reject with the signal's reason rather than an AbortError.
		error === timeoutSignal.reason
	);
}

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
	// Full jitter: random within [0, exponential] to spread retries across many
	// concurrent callers hammering the same overloaded model.
	return Math.round(Math.random() * exponential);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run a model-bearing call with a per-attempt timeout and capacity-aware retry.
 *
 * - Capacity (429) errors are retried with exponential backoff + full jitter.
 * - A per-attempt timeout aborts a stalled call and throws `ModelTimeoutError`
 *   (loud, bounded -- the workflow's at-least-once restart handles re-running).
 * - Any other error is rethrown immediately.
 *
 * @param fn receives the per-attempt `AbortSignal`; forward it to the model call.
 *   Returns a `PromiseLike` so Flue's awaitable `CallHandle` can be passed through
 *   directly (`session.skill(..., { signal })`).
 */
export async function withCapacityRetry<T>(
	fn: (signal: AbortSignal) => PromiseLike<T>,
	options: CapacityRetryOptions,
): Promise<T> {
	const attempts = options.attempts ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 3000;
	const maxDelayMs = options.maxDelayMs ?? 30000;

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const timeoutSignal =
			options.perAttemptTimeoutMs !== undefined
				? AbortSignal.timeout(options.perAttemptTimeoutMs)
				: undefined;
		const signals = [options.signal, timeoutSignal].filter(
			(s): s is AbortSignal => s !== undefined,
		);
		const signal =
			signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? new AbortController().signal);

		try {
			return await fn(signal);
		} catch (error) {
			lastError = error;

			// A per-attempt timeout: fail loudly, do not retry.
			if (isTimeoutAbort(error, timeoutSignal)) {
				throw new ModelTimeoutError(options.label, options.perAttemptTimeoutMs ?? 0, error);
			}
			// Caller cancellation: propagate untouched.
			if (options.signal?.aborted) throw error;
			// Non-capacity error: not our concern, rethrow.
			if (!isCapacityError(error)) throw error;
			// Capacity error on the final attempt: give up loudly.
			if (attempt === attempts) break;

			const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
			options.onRetry?.({ attempt, delayMs, error });
			await sleep(delayMs, options.signal);
		}
	}

	throw new CapacityExhaustedError(options.label, attempts, lastError);
}
