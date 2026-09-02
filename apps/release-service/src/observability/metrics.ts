import { env } from "cloudflare:workers";

const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIMENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENTS = new Set<OperationsMetricEvent>([
	"access_denied",
	"archive_gap",
	"configuration_failure",
	"directory_failure",
	"intent_rate_limited",
	"publication_paused",
	"reconciliation_required",
	"refresh_failure",
	"restore_failure",
	"verifier_failure",
]);

export type OperationsMetricEvent =
	| "access_denied"
	| "archive_gap"
	| "configuration_failure"
	| "directory_failure"
	| "intent_rate_limited"
	| "publication_paused"
	| "reconciliation_required"
	| "refresh_failure"
	| "restore_failure"
	| "verifier_failure";

export interface OperationsMetricInput {
	event: OperationsMetricEvent;
	ownerHash?: string;
	outcome?: string;
	scope?: string;
	requestId?: string;
	value?: number;
	timestamp?: number;
}

function optionalDimension(value: string | undefined): string | null {
	if (value === undefined) return null;
	if (!DIMENSION_PATTERN.test(value)) throw new TypeError("Invalid operations metric");
	return value;
}

export function writeOperationsMetric(
	input: OperationsMetricInput,
	dataset: AnalyticsEngineDataset = env.OPERATIONS_METRICS,
): void {
	const timestamp = input.timestamp ?? Date.now();
	const value = input.value ?? 1;
	if (
		!EVENTS.has(input.event) ||
		(input.ownerHash !== undefined && !HASH_PATTERN.test(input.ownerHash)) ||
		!Number.isFinite(value) ||
		!Number.isSafeInteger(timestamp) ||
		timestamp < 0
	) {
		throw new TypeError("Invalid operations metric");
	}
	try {
		dataset.writeDataPoint({
			indexes: [input.ownerHash ?? "global"],
			blobs: [
				input.event,
				optionalDimension(input.outcome),
				optionalDimension(input.scope),
				optionalDimension(input.requestId),
			],
			doubles: [value, timestamp],
		});
	} catch {
		console.error(JSON.stringify({ event: "operations_metric_write_failed" }));
	}
}
