import type { LabelSubscriptionDO } from "../label-subscription-do.js";
import type { LabelPublicationTarget } from "../labels/types.js";

export const LABEL_SUBSCRIPTION_DO_NAME = "listing-labels";

export function createLabelPublicationTarget(
	namespace: DurableObjectNamespace<LabelSubscriptionDO>,
): LabelPublicationTarget {
	const subscription = namespace.getByName(LABEL_SUBSCRIPTION_DO_NAME);
	return {
		async notify(sequence) {
			await subscription.notify(sequence);
		},
	};
}

export interface PublicationBackstopResult {
	attempted: number;
	accepted: number;
	failed: number;
}

export async function publishPendingLabels(
	db: D1Database,
	target: LabelPublicationTarget,
	limit = 100,
): Promise<PublicationBackstopResult> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		throw new TypeError("limit must be an integer between 1 and 1000");
	}
	const result = await db
		.prepare(
			`SELECT sequence FROM issued_labels
			 WHERE publication_pending = 1
			 ORDER BY sequence ASC
			 LIMIT ?`,
		)
		.bind(limit)
		.all<{ sequence: number }>();
	let accepted = 0;
	let failed = 0;
	for (const row of result.results ?? []) {
		try {
			await target.notify(row.sequence);
			accepted++;
		} catch {
			failed++;
		}
	}
	return { attempted: accepted + failed, accepted, failed };
}
