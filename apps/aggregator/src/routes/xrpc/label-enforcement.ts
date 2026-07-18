/**
 * Shared label enforcement (SQL exclusion) and hydration (view `labels`)
 * for the Read API, keyed off the request's accepted-labeler policy
 * (W4.4, `request-policy.ts`).
 *
 * Two separate concerns live here:
 *   - `build*EnforcementSql` appends a `NOT EXISTS` clause that excludes
 *     subjects carrying a hard-block label from an accepted source. Used
 *     for search (page-level filtering) and latest-release selection.
 *   - `hydrateLabels` fetches the actual label rows for a set of subjects
 *     so views can carry them on the wire; `isRedacted` then decides
 *     whether a `redact: true` source's `!takedown` should turn a 200
 *     into a 404 (`getPackage`/`resolvePackage`/`listReleases`).
 *
 * Both builders take `nowMs` explicitly (rather than calling `Date.now()`
 * internally) so a single request's SQL-side exclusion and hydration pass
 * agree on the same instant.
 */

import { NSID } from "@emdash-cms/registry-lexicons";
import {
	AUTOMATED_BLOCKS,
	PACKAGE_SCOPE_BLOCK_VALUES,
	RELEASE_BLOCK_VALUES,
	type AcceptedLabelerPolicy,
} from "@emdash-cms/registry-moderation";

/** Keeps a hydration query's `uri IN (...)` clause within D1's
 * bound-parameter limit when a page carries many subjects. */
const HYDRATION_CHUNK_SIZE = 50;
/** Matches the lexicon's `labels` maxLength on both `packageView` and
 * `releaseView`. Applied only at the view boundary (`capLabels`), never to
 * hydration results — redaction decisions must see the full label set. */
export const LABELS_MAX_LENGTH = 64;

/** Release-scope automated-block values (`RELEASE_BLOCK_VALUES` minus the
 * manual `security-yanked` / `!takedown`). The override exception below
 * applies only to these — the manual values are never suppressed. */
const AUTOMATED_BLOCK_VALUES: readonly string[] = [...AUTOMATED_BLOCKS];
/** The manual release blocks the reviewer override pair never suppresses. */
const MANUAL_RELEASE_BLOCK_VALUES: readonly string[] = RELEASE_BLOCK_VALUES.filter(
	(value) => !AUTOMATED_BLOCKS.has(value),
);

export interface EnforcementSql {
	sql: string;
	bindings: unknown[];
}

/** Matches `com.atproto.label.defs#label`'s optional fields; hydrated
 * views never carry `sig` or `ver` (nor `neg` — only active labels are
 * hydrated in the first place). */
export interface LabelView {
	src: string;
	uri: string;
	cid?: string;
	val: string;
	cts: string;
	exp?: string;
}

export interface HydrationSubject {
	uri: string;
	/** Omit for a subject with no single current version (publisher DIDs).
	 * A CID-bound label never applies to such a subject. */
	currentCid?: string;
}

function inClause(values: readonly string[]): string {
	return values.map(() => "?").join(", ");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size)
		out.push(items.slice(index, index + size));
	return out;
}

/**
 * `NOT EXISTS` clause excluding a package whose profile URI or publisher
 * DID carries an active, unexpired `PACKAGE_SCOPE_BLOCK_VALUES` label from
 * an accepted source. Empty `accepted` is a no-op (no enforcement without
 * an accepted policy to enforce). All values — source DIDs, label values,
 * `nowMs` — are bound parameters; only the compile-time NSID constant is
 * interpolated into the SQL text.
 *
 * Deliberately BROADER than `evaluateReleaseModeration`'s subject rules,
 * always in the fail-closed (over-hide) direction: the shared CID predicate
 * lets a CID-bound label match at DID scope, and value/subject pairings the
 * evaluator would reject (e.g. `publisher-compromised` on a package URI)
 * still exclude here. Read enforcement hides; the evaluator remains the
 * only eligibility engine.
 */
export function buildPackageEnforcementSql(
	accepted: AcceptedLabelerPolicy[],
	nowMs: number,
	alias = "p.",
): EnforcementSql {
	if (accepted.length === 0) return { sql: "", bindings: [] };
	const srcs = accepted.map((policy) => policy.did);
	const sql = `
		AND NOT EXISTS (
			SELECT 1 FROM label_state ls
			WHERE ls.src IN (${inClause(srcs)})
			  AND ls.val IN (${inClause(PACKAGE_SCOPE_BLOCK_VALUES)})
			  AND (ls.uri = 'at://' || ${alias}did || '/${NSID.packageProfile}/' || ${alias}slug OR ls.uri = ${alias}did)
			  AND ls.neg = 0
			  AND (ls.exp_epoch_ms IS NULL OR ls.exp_epoch_ms > ?)
			  AND (ls.cid IS NULL OR ls.cid = json_extract(${alias}signature_metadata, '$.cid'))
		)
	`;
	return { sql, bindings: [...srcs, ...PACKAGE_SCOPE_BLOCK_VALUES, nowMs] };
}

export interface ReleaseEnforcementAliases {
	/** Alias (with trailing dot) of the `releases` row. Default `"r."`. */
	release?: string;
	/** Alias (with trailing dot) of the joined `packages` row, needed for
	 * the package-scope cascade's CID comparison. Default `"p."`. */
	package?: string;
}

/**
 * `NOT EXISTS` clause excluding a release whose own URI carries a
 * `RELEASE_BLOCK_VALUES` label, or whose parent package URI / publisher DID
 * carries a `PACKAGE_SCOPE_BLOCK_VALUES` label (cascade), from an accepted
 * source. Requires the `packages` row joined under `aliases.package` — the
 * package-scope branch's CID comparison reads its `signature_metadata`.
 *
 * Mirrors the hydrated evaluator's §10 override rule (see
 * `evaluateReleaseModerationCore` in `@emdash-cms/registry-moderation`): a
 * source's exact-CID `assessment-passed` + `assessment-overridden` pair
 * suppresses that same source's automated blocks for the release. Without
 * this, a post-override re-assessment that re-issues a live automated block
 * would keep the release out of latest-selection even though the evaluator
 * treats it as eligible. The exception is scoped exactly as the evaluator
 * scopes it: automated blocks on the release URI only — the manual
 * `security-yanked` / `!takedown` release blocks and the package/publisher
 * cascade are never suppressed by the pair.
 */
export function buildReleaseEnforcementSql(
	accepted: AcceptedLabelerPolicy[],
	nowMs: number,
	aliases: ReleaseEnforcementAliases = {},
): EnforcementSql {
	if (accepted.length === 0) return { sql: "", bindings: [] };
	const releaseAlias = aliases.release ?? "r.";
	const packageAlias = aliases.package ?? "p.";
	const srcs = accepted.map((policy) => policy.did);
	const releaseUriExpr = `'at://' || ${releaseAlias}did || '/${NSID.packageRelease}/' || ${releaseAlias}rkey`;
	const releaseCidExpr = `json_extract(${releaseAlias}signature_metadata, '$.cid')`;
	const sql = `
		AND NOT EXISTS (
			SELECT 1 FROM label_state ls
			WHERE ls.src IN (${inClause(srcs)})
			  AND ls.neg = 0
			  AND (ls.exp_epoch_ms IS NULL OR ls.exp_epoch_ms > ?)
			  AND (
					(
						ls.uri = ${releaseUriExpr}
						AND ls.val IN (${inClause(AUTOMATED_BLOCK_VALUES)})
						AND (ls.cid IS NULL OR ls.cid = ${releaseCidExpr})
						AND NOT (
							EXISTS (
								SELECT 1 FROM label_state pass
								WHERE pass.src = ls.src
								  AND pass.uri = ${releaseUriExpr}
								  AND pass.val = 'assessment-passed'
								  AND pass.cid = ${releaseCidExpr}
								  AND pass.neg = 0
								  AND (pass.exp_epoch_ms IS NULL OR pass.exp_epoch_ms > ?)
							)
							AND EXISTS (
								SELECT 1 FROM label_state ovr
								WHERE ovr.src = ls.src
								  AND ovr.uri = ${releaseUriExpr}
								  AND ovr.val = 'assessment-overridden'
								  AND ovr.cid = ${releaseCidExpr}
								  AND ovr.neg = 0
								  AND (ovr.exp_epoch_ms IS NULL OR ovr.exp_epoch_ms > ?)
							)
						)
					)
					OR
					(
						ls.uri = ${releaseUriExpr}
						AND ls.val IN (${inClause(MANUAL_RELEASE_BLOCK_VALUES)})
						AND (ls.cid IS NULL OR ls.cid = ${releaseCidExpr})
					)
					OR
					(
						(ls.uri = 'at://' || ${packageAlias}did || '/${NSID.packageProfile}/' || ${packageAlias}slug OR ls.uri = ${releaseAlias}did)
						AND ls.val IN (${inClause(PACKAGE_SCOPE_BLOCK_VALUES)})
						AND (ls.cid IS NULL OR ls.cid = json_extract(${packageAlias}signature_metadata, '$.cid'))
					)
			  )
		)
	`;
	return {
		sql,
		bindings: [
			...srcs,
			nowMs,
			...AUTOMATED_BLOCK_VALUES,
			nowMs,
			nowMs,
			...MANUAL_RELEASE_BLOCK_VALUES,
			...PACKAGE_SCOPE_BLOCK_VALUES,
		],
	};
}

interface LabelStateRow {
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	cts: string;
	exp: string | null;
}

/**
 * Fetches active, unexpired label rows from accepted sources for a set of
 * subjects, applying CID applicability app-side (a CID-bound label applies
 * only when it matches the subject's current CID; `cid IS NULL` is
 * URI-wide). Returns a `Map` keyed by subject URI — callers combine the
 * entries relevant to one view (e.g. release + package + publisher URIs).
 *
 * Returns UNTRUNCATED label sets: `isRedacted` must see every applicable
 * label, or a `!takedown` past a truncation boundary silently un-redacts
 * the subject. The lexicon's 64-label wire cap is applied by the views
 * (`capLabels`), after redaction has been decided.
 */
export async function hydrateLabels(
	db: D1DatabaseSession,
	accepted: AcceptedLabelerPolicy[],
	subjects: HydrationSubject[],
	nowMs: number,
): Promise<Map<string, LabelView[]>> {
	const out = new Map<string, LabelView[]>();
	if (accepted.length === 0 || subjects.length === 0) return out;

	const currentCidByUri = new Map<string, string | undefined>();
	const uris: string[] = [];
	for (const subject of subjects) {
		if (!currentCidByUri.has(subject.uri)) uris.push(subject.uri);
		currentCidByUri.set(subject.uri, subject.currentCid);
	}
	const srcs = accepted.map((policy) => policy.did);

	for (const batch of chunk(uris, HYDRATION_CHUNK_SIZE)) {
		const result = await db
			.prepare(
				`SELECT src, uri, cid, val, cts, exp
				 FROM label_state
				 WHERE uri IN (${inClause(batch)})
				   AND src IN (${inClause(srcs)})
				   AND neg = 0
				   AND (exp_epoch_ms IS NULL OR exp_epoch_ms > ?)`,
			)
			.bind(...batch, ...srcs, nowMs)
			.all<LabelStateRow>();

		for (const row of result.results ?? []) {
			const currentCid = currentCidByUri.get(row.uri);
			if (row.cid !== null && row.cid !== currentCid) continue;
			const label: LabelView = { src: row.src, uri: row.uri, val: row.val, cts: row.cts };
			if (row.cid !== null) label.cid = row.cid;
			if (row.exp !== null) label.exp = row.exp;
			const existing = out.get(row.uri);
			if (existing) existing.push(label);
			else out.set(row.uri, [label]);
		}
	}

	return out;
}

/** True iff any hydrated label is an active `!takedown` from a source
 * whose accepted policy has `redact: true`. Applicability (CID scoping,
 * expiry, negation) was already established by `hydrateLabels`. */
export function isRedacted(labels: LabelView[], accepted: AcceptedLabelerPolicy[]): boolean {
	const redactBySrc = new Map(accepted.map((policy) => [policy.did, policy.redact]));
	return labels.some((label) => label.val === "!takedown" && redactBySrc.get(label.src) === true);
}
