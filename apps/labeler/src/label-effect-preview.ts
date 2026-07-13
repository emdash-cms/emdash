/**
 * Server-derived effect preview for a proposed reviewer label action (plan
 * W9.4, spec §11.4 "resulting official-client effect"). The console holds zero
 * policy logic: it renders whatever this endpoint returns. Grounding is the
 * exact machinery official clients use — `getActiveLabelState`'s canonical
 * `(src, uri, val)` stream reduction with CID applicability, fed into
 * `registry-moderation`'s release evaluator (the aggregator / #1972 source of
 * truth) with the proposal overlaid as one more `(uri, val, cid, neg)` event.
 */

import {
	evaluateHydratedReleaseModeration,
	type ModerationLabel,
	type ReleaseModeration,
} from "@emdash-cms/registry-moderation";

import { getActiveLabelState, getCurrentSubjectByUri } from "./assessment-store.js";
import { getLabelDefinition } from "./policy.js";
import { parseSubjectKind } from "./service.js";

export interface EffectPreviewParams {
	uri: string;
	val: string;
	cid?: string;
	neg: boolean;
}

export interface SupersededLabel {
	val: string;
	cid: string | null;
	sequence: number;
}

export interface EffectPreview {
	/** The label's own official effect from policy (block/warn/redact/pass/…). */
	labelEffect: string;
	scope: "cid-bound" | "uri-wide";
	/** The currently-active label in this value's stream that the action would
	 * replace (a retract negates it; a re-issue supersedes it) — empty when the
	 * value has no active label yet. */
	supersedes: SupersededLabel[];
	/** Resolved release moderation now, and with the proposal overlaid. Only a
	 * release subject has a release evaluation; package/publisher subjects (and
	 * releases with no observed subject row) report `null`. */
	before: ReleaseModeration | null;
	after: ReleaseModeration | null;
}

/**
 * Computes the effect preview, or `null` when `val` is not a known policy label
 * (the caller maps that to a 400). Every other field is best-effort: an
 * unresolvable release context yields `before`/`after` `null` rather than
 * failing the whole read.
 */
export async function computeEffectPreview(
	db: D1Database,
	labelerDid: string,
	params: EffectPreviewParams,
	now: Date,
): Promise<EffectPreview | null> {
	const definition = getLabelDefinition(params.val);
	if (!definition) return null;

	const scope: EffectPreview["scope"] = params.cid !== undefined ? "cid-bound" : "uri-wide";
	const preview: EffectPreview = {
		labelEffect: definition.officialEffect,
		scope,
		supersedes: [],
		before: null,
		after: null,
	};

	// A release evaluation needs the release CID being evaluated. For a CID-bound
	// action it is the proposal CID; for a URI-wide action (e.g. security-yanked)
	// it is the current release CID from the observed subject row.
	const subject = await getCurrentSubjectByUri(db, params.uri);
	const isRelease =
		parseSubjectKind(params.uri) === "release" && subject?.collection.endsWith(".release") === true;
	const contextCid = params.cid ?? subject?.cid;

	if (contextCid === undefined) return preview;

	const active = await getActiveLabelState(db, {
		src: labelerDid,
		uri: params.uri,
		cid: contextCid,
		now,
	});
	const supersededWinner = active.get(params.val);
	if (supersededWinner && supersededWinner.active) {
		preview.supersedes = [
			{
				val: supersededWinner.val,
				cid: supersededWinner.cid,
				sequence: supersededWinner.sequence,
			},
		];
	}

	if (!isRelease || !subject) return preview;

	// Active winners are non-negated, unexpired, and applicable to `contextCid`,
	// so they reconstruct as positive `ModerationLabel`s. The overlay carries a
	// `now` cts so it wins its own `(uri, val)` stream in the re-reduction.
	const activeLabels: ModerationLabel[] = [];
	for (const winner of active.values()) {
		if (!winner.active) continue;
		activeLabels.push({
			ver: 1,
			src: labelerDid,
			uri: params.uri,
			...(winner.cid === null ? {} : { cid: winner.cid }),
			val: winner.val,
			cts: winner.cts,
			...(winner.exp === null ? {} : { exp: winner.exp }),
		});
	}

	const overlay: ModerationLabel = {
		ver: 1,
		src: labelerDid,
		uri: params.uri,
		...(params.cid === undefined ? {} : { cid: params.cid }),
		val: params.val,
		...(params.neg ? { neg: true } : {}),
		cts: now.toISOString(),
	};

	const context = {
		publisherDid: subject.did,
		package: { uri: params.uri, cid: contextCid },
		release: { uri: params.uri, cid: contextCid },
	};
	const acceptedLabelers = [{ did: labelerDid, redact: false }];

	try {
		preview.before = evaluateHydratedReleaseModeration({
			acceptedLabelers,
			context,
			evaluatedAt: now,
			labels: activeLabels,
		});
		preview.after = evaluateHydratedReleaseModeration({
			acceptedLabelers,
			context,
			evaluatedAt: now,
			labels: [...activeLabels, overlay],
		});
	} catch {
		// A malformed URI/CID the evaluator rejects leaves before/after null; the
		// scope + labelEffect + supersedes fields are still useful to the console.
		preview.before = null;
		preview.after = null;
	}

	return preview;
}
