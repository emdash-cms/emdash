import type { IssuableLabel } from "./api/types.js";

/**
 * Presentation menus for the reviewer action dialog. These mirror the ratified
 * moderation policy's reviewer-issuable labels so the console can offer a picker,
 * but they are NOT the enforcement boundary — the server (`assertW94Issuable` +
 * the signing-layer `validateManualProposal`) is authoritative and rejects
 * anything outside policy regardless of what the menu offers. A `scope` of
 * `cid-bound` targets the exact release CID (policy `cidRule: required`);
 * `uri-wide` targets the whole record (`cidRule: forbidden`).
 */

/** Reviewer-issuable labels on a release subject: the descriptive
 * warning/block vocabulary (CID-bound) plus the URI-wide security yank. */
export const RELEASE_ISSUABLE_LABELS: readonly IssuableLabel[] = [
	{ val: "security-yanked", scope: "uri-wide" },
	{ val: "malware", scope: "cid-bound" },
	{ val: "data-exfiltration", scope: "cid-bound" },
	{ val: "credential-harvesting", scope: "cid-bound" },
	{ val: "supply-chain-compromise", scope: "cid-bound" },
	{ val: "critical-vulnerability", scope: "cid-bound" },
	{ val: "artifact-integrity-failure", scope: "cid-bound" },
	{ val: "invalid-bundle", scope: "cid-bound" },
	{ val: "undeclared-access", scope: "cid-bound" },
	{ val: "impersonation", scope: "cid-bound" },
	{ val: "suspicious-code", scope: "cid-bound" },
	{ val: "obfuscated-code", scope: "cid-bound" },
	{ val: "privacy-risk", scope: "cid-bound" },
	{ val: "misleading-metadata", scope: "cid-bound" },
	{ val: "low-quality", scope: "cid-bound" },
	{ val: "broken-release", scope: "cid-bound" },
];

/** Reviewer-issuable labels on a package (profile) subject. */
export const PACKAGE_ISSUABLE_LABELS: readonly IssuableLabel[] = [
	{ val: "package-disputed", scope: "uri-wide" },
];

/** The automated blocking label vocabulary (policy `category: automated-block`),
 * mirrored so the console can list a release's active blocks for the override
 * ceremony. Presentation only — the server re-derives the authoritative set from
 * live label state and rejects a stale submission. */
export const AUTOMATED_BLOCK_LABELS: ReadonlySet<string> = new Set([
	"malware",
	"data-exfiltration",
	"credential-harvesting",
	"supply-chain-compromise",
	"critical-vulnerability",
	"artifact-integrity-failure",
	"invalid-bundle",
	"undeclared-access",
	"impersonation",
]);

export function isAutomatedBlock(val: string): boolean {
	return AUTOMATED_BLOCK_LABELS.has(val);
}

const RELEASE_SCOPES = new Map(RELEASE_ISSUABLE_LABELS.map((entry) => [entry.val, entry.scope]));

/** The ceremony scope for a value already active on a release, so a retract
 * targets the same scope it was issued at. Defaults to `cid-bound` for the
 * descriptive vocabulary. */
export function releaseLabelScope(val: string): IssuableLabel["scope"] {
	return RELEASE_SCOPES.get(val) ?? "cid-bound";
}

/** Whether a value is reviewer-issuable on a release subject, and therefore
 * retractable through the issue/retract endpoints. Mirrors the server's policy
 * allow-set so the retract button renders only where the action can succeed —
 * eligibility labels (assessment-passed/overridden/pending/error) are absent
 * from the issuable set and are rejected by the server's `assertW94Issuable`. */
export function isReleaseRetractable(val: string): boolean {
	return RELEASE_SCOPES.has(val);
}
