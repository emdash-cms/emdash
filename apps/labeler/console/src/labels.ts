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

const RELEASE_SCOPES = new Map(RELEASE_ISSUABLE_LABELS.map((entry) => [entry.val, entry.scope]));

/** The ceremony scope for a value already active on a release, so a retract
 * targets the same scope it was issued at. Defaults to `cid-bound` for the
 * descriptive vocabulary. */
export function releaseLabelScope(val: string): IssuableLabel["scope"] {
	return RELEASE_SCOPES.get(val) ?? "cid-bound";
}
