/**
 * Comment ranking utilities (Tier 1 of the best-in-class comments RFC).
 *
 * Wilson score lower-bound (95% confidence) — the same primitive Reddit uses
 * for its "Best" comment sort. Ranks by the statistical lower bound of the
 * positive-reaction proportion rather than the raw count, so a comment with a
 * couple of reactions can't outrank a heavily-reacted one until it earns
 * confidence, and a late-but-popular comment still rises (submission time is
 * irrelevant).
 *
 * Positive-only reactions (the recommended default) degrade gracefully: with
 * `down = 0` the score still increases monotonically with `up` while penalising
 * low-sample comments — wilson(1,0) ≈ 0.21, wilson(10,0) ≈ 0.73,
 * wilson(200,0) ≈ 0.98.
 */

/** z for a 95% two-sided confidence interval. */
const DEFAULT_Z = 1.96;

/** Reactions that count against a comment when both signals are in use. */
const NEGATIVE_REACTIONS: ReadonlySet<string> = new Set(["dislike", "down"]);

/**
 * Wilson score lower bound of the positive proportion.
 *
 * @param up   count of positive reactions
 * @param down count of negative reactions
 * @returns a score in [0, 1]; 0 when there are no reactions
 */
export function wilsonLowerBound(up: number, down: number, z: number = DEFAULT_Z): number {
	const n = up + down;
	if (n <= 0) return 0;
	const phat = up / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const centre = phat + z2 / (2 * n);
	const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
	return (centre - margin) / denom;
}

/**
 * Reduce a per-reaction count map to a single rank score via the Wilson
 * lower bound. Any reaction not in {@link NEGATIVE_REACTIONS} is treated as
 * positive, so the positive-only default (just `like`) works without special
 * casing.
 */
export function reactionScore(counts: Record<string, number>): number {
	let up = 0;
	let down = 0;
	for (const [reaction, count] of Object.entries(counts)) {
		if (NEGATIVE_REACTIONS.has(reaction)) {
			down += count;
		} else {
			up += count;
		}
	}
	return wilsonLowerBound(up, down);
}
