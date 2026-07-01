/**
 * Redirect rule status codes.
 *
 * A redirect rule's `type` is either a *redirect* status (issues a `Location`
 * header) or a *terminal* status (serves the status with no target). Terminal
 * statuses let editors mark a URL as intentionally gone:
 * - `410 Gone` — permanently and intentionally deleted (Google deindexes it
 *   faster than a 404).
 * - `451 Unavailable For Legal Reasons`.
 */

/** Statuses that issue an HTTP redirect (require a destination). */
export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;

/** Terminal statuses that serve a status with no `Location` / no destination. */
export const TERMINAL_STATUSES = [410, 451] as const;

/** All values accepted as a redirect rule `type`. */
export const REDIRECT_RULE_STATUSES: readonly number[] = [
	...REDIRECT_STATUSES,
	...TERMINAL_STATUSES,
];

/** True for terminal statuses (410/451) — served directly, with no target. */
export function isTerminalStatus(type: number): boolean {
	return (TERMINAL_STATUSES as readonly number[]).includes(type);
}
