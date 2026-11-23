/** Caps how many plugin reviews run per publisher and in total, per UTC day. */
export interface ReviewBudget {
	reserve(publisherDid: string, now: Date): Promise<ReviewBudgetReservation>;
}

export type ReviewBudgetReservation = { reserved: true } | { reserved: false; retryAt: string };

export interface ReviewBudgetLimits {
	perPublisherPerDay: number;
	totalPerDay: number;
}

export const DEFAULT_REVIEW_BUDGET_LIMITS: ReviewBudgetLimits = {
	perPublisherPerDay: 20,
	totalPerDay: 500,
};

const GLOBAL_SCOPE = "*";

export function createD1ReviewBudget(db: D1Database, limits: ReviewBudgetLimits): ReviewBudget {
	const increment = (scope: string, window: string, limit: number) =>
		db
			.prepare(
				`INSERT INTO code_review_budget (scope, window_start, count) VALUES (?, ?, 1)
				 ON CONFLICT (scope, window_start) DO UPDATE SET count = count + 1 WHERE count < ?
				 RETURNING count`,
			)
			.bind(scope, window, limit)
			.first<{ count: number }>();
	return {
		async reserve(publisherDid, now) {
			const window = now.toISOString().slice(0, 10);
			const retryAt = nextUtcDay(now).toISOString();
			if (!(await increment(publisherDid, window, limits.perPublisherPerDay))) {
				return { reserved: false, retryAt };
			}
			if (!(await increment(GLOBAL_SCOPE, window, limits.totalPerDay))) {
				await db
					.prepare(
						"UPDATE code_review_budget SET count = count - 1 WHERE scope = ? AND window_start = ?",
					)
					.bind(publisherDid, window)
					.run();
				return { reserved: false, retryAt };
			}
			return { reserved: true };
		},
	};
}

function nextUtcDay(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
