import { isDid } from "@atcute/lexicons/syntax";
import { NSID } from "@emdash-cms/registry-lexicons";
import {
	ListingModerationPolicySchema,
	type ListingModerationPolicy,
} from "@emdash-cms/registry-moderation";

import { REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS } from "./label-source-health.js";

export type ListingPolicyMode = "open" | "allowlist" | "projection";

export interface ListingPolicyConfig {
	mode: ListingPolicyMode;
	allowlist: ReadonlySet<string>;
	allowlistJson: string;
	moderationPolicy: ListingModerationPolicy | null;
	moderationPolicyVersion: string;
	moderationPolicyHash: string;
	requiredPositiveSources: readonly string[];
	acceptedStateSources: readonly string[];
	redactionSources: readonly string[];
	requiredPositiveSourcesJson: string;
	acceptedStateSourcesJson: string;
	redactionSourcesJson: string;
}

export class InvalidAcceptedLabelersError extends Error {
	override readonly name = "InvalidAcceptedLabelersError";
}

function isListingPolicyMode(value: string): value is ListingPolicyMode {
	return value === "open" || value === "allowlist" || value === "projection";
}

export function packageProfileUri(did: string, slug: string): string {
	return `at://${did}/${NSID.packageProfile}/${slug}`;
}

interface CachedPolicy {
	mode: string;
	allowlist: string;
	moderationPolicy: string;
	value: Promise<ListingPolicyConfig>;
}

type PolicyCache = WeakMap<object, CachedPolicy>;

const POLICY_CACHE_KEY = Symbol.for("emdash:aggregator:listing-policy-cache");
const globals = globalThis as Record<symbol, unknown>;
const policyCache: PolicyCache =
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shared across duplicated Worker chunks
	(globals[POLICY_CACHE_KEY] as PolicyCache | undefined) ??
	(() => {
		const cache: PolicyCache = new WeakMap();
		globals[POLICY_CACHE_KEY] = cache;
		return cache;
	})();

export function getListingPolicy(env: Env): Promise<ListingPolicyConfig> {
	const rawMode = env.LISTING_POLICY_MODE;
	const rawAllowlist = env.LISTING_ALLOWLIST;
	const rawModerationPolicy = env.LISTING_MODERATION_POLICY;
	const cached = policyCache.get(env);
	if (
		cached?.mode === rawMode &&
		cached.allowlist === rawAllowlist &&
		cached.moderationPolicy === rawModerationPolicy
	) {
		return cached.value;
	}
	const value = buildListingPolicy(rawMode, rawAllowlist, rawModerationPolicy);
	policyCache.set(env, {
		mode: rawMode,
		allowlist: rawAllowlist,
		moderationPolicy: rawModerationPolicy,
		value,
	});
	return value;
}

async function buildListingPolicy(
	rawMode: string,
	rawAllowlist: string,
	rawModerationPolicy: string,
): Promise<ListingPolicyConfig> {
	const mode = isListingPolicyMode(rawMode) ? rawMode : "projection";
	const allowlist = mode === "allowlist" ? parseAllowlist(rawAllowlist) : new Set<string>();
	let decoded: unknown;
	try {
		decoded = JSON.parse(rawModerationPolicy);
	} catch {
		return invalidPolicy(mode, allowlist);
	}
	const parsed = ListingModerationPolicySchema.safeParse(decoded);
	if (!parsed.success) return invalidPolicy(mode, allowlist);
	const canonical = JSON.stringify(parsed.data);
	return {
		mode,
		allowlist,
		allowlistJson: JSON.stringify([...allowlist]),
		moderationPolicy: parsed.data,
		moderationPolicyVersion: parsed.data.policyVersion,
		moderationPolicyHash: await sha256(canonical),
		requiredPositiveSources: parsed.data.requiredPositiveSources,
		acceptedStateSources: parsed.data.acceptedStateSources,
		redactionSources: parsed.data.redactionSources,
		requiredPositiveSourcesJson: JSON.stringify(parsed.data.requiredPositiveSources),
		acceptedStateSourcesJson: JSON.stringify(parsed.data.acceptedStateSources),
		redactionSourcesJson: JSON.stringify(parsed.data.redactionSources),
	};
}

function invalidPolicy(
	mode: ListingPolicyMode,
	allowlist: ReadonlySet<string>,
): ListingPolicyConfig {
	const safeAllowlist = mode === "allowlist" ? new Set<string>() : allowlist;
	return {
		mode,
		allowlist: safeAllowlist,
		allowlistJson: JSON.stringify([...safeAllowlist]),
		moderationPolicy: null,
		moderationPolicyVersion: "",
		moderationPolicyHash: "invalid",
		requiredPositiveSources: [],
		acceptedStateSources: [],
		redactionSources: [],
		requiredPositiveSourcesJson: "[]",
		acceptedStateSourcesJson: "[]",
		redactionSourcesJson: "[]",
	};
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseAllowlist(raw: string): ReadonlySet<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return new Set();
	}
	if (!Array.isArray(parsed)) return new Set();

	const entries = new Set<string>();
	for (const value of parsed) {
		if (typeof value !== "string" || !isPackageProfileUri(value)) return new Set();
		entries.add(value);
	}
	return entries;
}

function isPackageProfileUri(value: string): boolean {
	if (!value.startsWith("at://")) return false;
	const parts = value.slice("at://".length).split("/");
	return (
		parts.length === 3 &&
		isDid(parts[0]) &&
		parts[1] === NSID.packageProfile &&
		parts[2] !== undefined &&
		parts[2].length > 0 &&
		!parts[2].includes("?") &&
		!parts[2].includes("#")
	);
}

export function isPackageAllowlisted(
	policy: ListingPolicyConfig,
	did: string,
	slug: string,
): boolean {
	return policy.allowlist.has(packageProfileUri(did, slug));
}

export function validateAcceptedLabelersHeader(
	raw: string | null,
	policy: ListingPolicyConfig,
): string | undefined {
	if (raw === null || raw.trim() === "") return undefined;
	const configured = new Set([
		...policy.requiredPositiveSources,
		...policy.acceptedStateSources,
		...policy.redactionSources,
	]);
	const sources: string[] = [];
	for (const entry of raw.split(",")) {
		const source = entry.trim();
		if (!isDid(source) || !configured.has(source) || sources.includes(source)) {
			throw new InvalidAcceptedLabelersError("accepted labelers header is invalid");
		}
		sources.push(source);
	}
	if (policy.requiredPositiveSources.some((source) => !sources.includes(source))) {
		throw new InvalidAcceptedLabelersError(
			"accepted labelers header cannot disable a required listing labeler",
		);
	}
	return sources.join(",");
}

export const ACTIVE_PROJECTION_JOINS_SQL = `
	JOIN public_projection_generations projection_generation
	  ON projection_generation.generation = projection_state.active_generation
`;

export const ACTIVE_PROJECTION_POLICY_SQL = `
	projection_generation.completed_at IS NOT NULL
	AND projection_generation.policy_mode = ?
	AND projection_generation.policy_version = ?
	AND projection_generation.policy_hash = ?
	AND NOT EXISTS (
		SELECT 1 FROM json_each(projection_generation.required_positive_sources) required_source
		WHERE NOT EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = required_source.value AND source.active = 1
				AND source.trusted = 1 AND source.required_positive = 1
				AND typeof(source.health_last_success_epoch) = 'integer'
				AND source.health_last_success_epoch > ?
				AND source.health_last_success_epoch <= ?
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM json_each(projection_generation.accepted_state_sources) state_source
		WHERE NOT EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = state_source.value AND source.active = 1
				AND source.trusted = 1 AND source.accepted_state = 1
				AND typeof(source.health_last_success_epoch) = 'integer'
				AND source.health_last_success_epoch > ?
				AND source.health_last_success_epoch <= ?
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM json_each(projection_generation.redaction_sources) redaction_source
		WHERE NOT EXISTS (
			SELECT 1 FROM labellers source
			WHERE source.did = redaction_source.value AND source.active = 1
				AND source.trusted = 1 AND source.redaction = 1
				AND typeof(source.health_last_success_epoch) = 'integer'
				AND source.health_last_success_epoch > ?
				AND source.health_last_success_epoch <= ?
		)
	)
`;

export function activeProjectionPolicyBindings(
	policy: ListingPolicyConfig,
	now = new Date(),
): unknown[] {
	const nowEpoch = now.getTime();
	if (!Number.isSafeInteger(nowEpoch)) throw new TypeError("projection policy time is invalid");
	const freshnessBoundary = nowEpoch - REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS;
	return [
		policy.mode,
		policy.moderationPolicyVersion,
		policy.moderationPolicyHash,
		freshnessBoundary,
		nowEpoch,
		freshnessBoundary,
		nowEpoch,
		freshnessBoundary,
		nowEpoch,
	];
}

const ACTIVE_LABEL_SQL = `
	listing_pass.trusted = 1
	AND listing_pass.collision = 0
	AND listing_pass.neg = 0
	AND (
		listing_pass.exp IS NULL
		OR EXISTS (
			SELECT 1 FROM listing_label_state_expiry listing_expiry
			WHERE listing_expiry.src = listing_pass.src
				AND listing_expiry.uri = listing_pass.uri
				AND listing_expiry.val = listing_pass.val
				AND listing_expiry.exp = listing_pass.exp
				AND listing_expiry.exp_epoch > unixepoch('now')
		)
	)
`;

export const ACTIVE_PUBLIC_PACKAGE_SQL = `
	NOT EXISTS (
		SELECT 1 FROM json_each(?) required_source
		WHERE NOT EXISTS (
			SELECT 1 FROM label_state listing_pass
			WHERE listing_pass.src = required_source.value
				AND listing_pass.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
				AND listing_pass.cid = p.profile_cid
				AND listing_pass.val = 'listing-passed'
				AND ${ACTIVE_LABEL_SQL}
		)
	)
	AND EXISTS (
		SELECT 1 FROM public_releases listing_release
		WHERE listing_release.generation = p.generation
			AND listing_release.did = p.did
			AND listing_release.package = p.slug
			AND listing_release.version = p.latest_version
			AND NOT EXISTS (
				SELECT 1 FROM json_each(?) required_source
				WHERE NOT EXISTS (
					SELECT 1 FROM label_state listing_pass
					WHERE listing_pass.src = required_source.value
						AND listing_pass.uri = 'at://' || listing_release.did ||
							'/${NSID.packageRelease}/' || listing_release.rkey
						AND listing_pass.cid = listing_release.release_cid
						AND listing_pass.val = 'listing-passed'
						AND ${ACTIVE_LABEL_SQL}
				)
			)
	)
`;

export const ACTIVE_PUBLIC_RELEASE_SQL = `
	NOT EXISTS (
		SELECT 1 FROM json_each(?) required_source
		WHERE NOT EXISTS (
			SELECT 1 FROM label_state listing_pass
			WHERE listing_pass.src = required_source.value
				AND listing_pass.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
				AND listing_pass.cid = p.profile_cid
				AND listing_pass.val = 'listing-passed'
				AND ${ACTIVE_LABEL_SQL}
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM json_each(?) required_source
		WHERE NOT EXISTS (
			SELECT 1 FROM label_state listing_pass
			WHERE listing_pass.src = required_source.value
				AND listing_pass.uri = 'at://' || r.did || '/${NSID.packageRelease}/' || r.rkey
				AND listing_pass.cid = r.release_cid
				AND listing_pass.val = 'listing-passed'
				AND ${ACTIVE_LABEL_SQL}
		)
	)
`;

export function activePublicSubjectBindings(policy: ListingPolicyConfig): unknown[] {
	return [policy.requiredPositiveSourcesJson, policy.requiredPositiveSourcesJson];
}

export const ACTIVE_PROFILE_SQL = `
	NOT EXISTS (
		SELECT 1 FROM package_profile_heads listing_head
		WHERE listing_head.did = p.did
		  AND listing_head.slug = p.slug
		  AND listing_head.deleted_at IS NOT NULL
	)
`;

export const ACTIVE_PROFILE_REDACTION_SQL = `
	NOT EXISTS (
		SELECT 1 FROM label_state redaction
		WHERE redaction.val IN ('!takedown', 'listing-blocked')
		  AND redaction.trusted = 1
		  AND (
			(redaction.val = '!takedown' AND EXISTS (
				SELECT 1 FROM labellers source
				WHERE source.did = redaction.src
				  AND source.active = 1 AND source.trusted = 1 AND source.redaction = 1
			))
			OR (redaction.val = 'listing-blocked' AND EXISTS (
				SELECT 1 FROM labellers source
				WHERE source.did = redaction.src
				  AND source.active = 1 AND source.trusted = 1
				  AND (source.required_positive = 1 OR source.accepted_state = 1)
			))
		  )
		  AND (
			(redaction.collision = 0 AND redaction.neg = 0
			  AND (
				(redaction.val = '!takedown' AND redaction.uri = p.did)
				OR (
					redaction.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
					AND (
						(redaction.val = '!takedown' AND (
							redaction.cid IS NULL
							OR redaction.cid = json_extract(p.signature_metadata, '$.cid')
						))
						OR (redaction.val = 'listing-blocked'
							AND redaction.cid = json_extract(p.signature_metadata, '$.cid'))
					)
				)
			  )
			  AND (
				redaction.exp IS NULL
				OR EXISTS (
					SELECT 1 FROM listing_label_state_expiry expiry
					WHERE expiry.src = redaction.src
					  AND expiry.uri = redaction.uri
					  AND expiry.val = redaction.val
					  AND expiry.exp = redaction.exp
					  AND expiry.exp_epoch > unixepoch('now')
				)
			  ))
			OR (redaction.collision = 1 AND (
				EXISTS (
					SELECT 1 FROM listing_labels candidate
					WHERE candidate.src = redaction.src
					  AND candidate.uri = redaction.uri
					  AND candidate.val = redaction.val
					  AND candidate.cts_epoch = redaction.cts_epoch
					  AND candidate.cts_fraction = redaction.cts_fraction
					  AND candidate.neg = 0
					  AND (
						(candidate.val = '!takedown' AND candidate.uri = p.did)
						OR (
							candidate.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
							AND (
								(candidate.val = '!takedown' AND (
									candidate.cid IS NULL
									OR candidate.cid = json_extract(p.signature_metadata, '$.cid')
								))
								OR (candidate.val = 'listing-blocked'
									AND candidate.cid = json_extract(p.signature_metadata, '$.cid'))
							)
						)
					  )
					  AND (candidate.exp IS NULL OR candidate.exp_epoch > unixepoch('now'))
				)
				OR (NOT EXISTS (
					SELECT 1 FROM listing_labels candidate
					WHERE candidate.src = redaction.src
					  AND candidate.uri = redaction.uri
					  AND candidate.val = redaction.val
					  AND candidate.cts_epoch = redaction.cts_epoch
					  AND candidate.cts_fraction = redaction.cts_fraction
				) AND (
					(redaction.val = '!takedown' AND redaction.uri = p.did)
					OR (
						redaction.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
						AND (
							(redaction.val = '!takedown' AND (
								redaction.cid IS NULL
								OR redaction.cid = json_extract(p.signature_metadata, '$.cid')
							))
							OR (redaction.val = 'listing-blocked'
								AND redaction.cid = json_extract(p.signature_metadata, '$.cid'))
						)
					)
				))
			))
		  )
	)
	AND NOT EXISTS (
		SELECT 1 FROM listing_replay_restrictions replay
		JOIN labellers source ON source.did = replay.src
		WHERE source.active = 1 AND source.replay_pending = 1
		  AND (
			(replay.val = '!takedown' AND source.redaction = 1)
			OR (replay.val = 'listing-blocked'
			  AND (source.required_positive = 1 OR source.accepted_state = 1))
		  )
		  AND (replay.exp_epoch IS NULL OR replay.exp_epoch > unixepoch('now'))
		  AND (
			(replay.val = '!takedown' AND replay.uri = p.did)
			OR (
				replay.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
				AND (
					(replay.val = '!takedown' AND (
						replay.cid IS NULL
						OR replay.cid = json_extract(p.signature_metadata, '$.cid')
					))
					OR (replay.val = 'listing-blocked'
						AND replay.cid = json_extract(p.signature_metadata, '$.cid'))
				)
			)
		  )
	)
`;

export const ACTIVE_RELEASE_REDACTION_SQL = `
	NOT EXISTS (
		SELECT 1 FROM label_state redaction
		WHERE redaction.uri = 'at://' || r.did || '/${NSID.packageRelease}/' || r.rkey
		  AND redaction.val IN ('listing-blocked', '!takedown', 'security:yanked', 'security-yanked')
		  AND redaction.trusted = 1
		  AND (
			(redaction.val = 'listing-blocked' AND EXISTS (
				SELECT 1 FROM labellers source
				WHERE source.did = redaction.src
				  AND source.active = 1 AND source.trusted = 1
				  AND (source.required_positive = 1 OR source.accepted_state = 1)
			))
			OR (redaction.val IN ('!takedown', 'security:yanked', 'security-yanked') AND EXISTS (
				SELECT 1 FROM labellers source
				WHERE source.did = redaction.src
				  AND source.active = 1 AND source.trusted = 1 AND source.redaction = 1
			))
		  )
		  AND (
			(redaction.collision = 0 AND redaction.neg = 0
			  AND (
				(redaction.val = 'listing-blocked'
				  AND redaction.cid = json_extract(r.signature_metadata, '$.cid'))
				OR (redaction.val IN ('!takedown', 'security:yanked', 'security-yanked') AND (
					redaction.cid IS NULL
					OR redaction.cid = json_extract(r.signature_metadata, '$.cid')
				))
			  )
			  AND (
				redaction.exp IS NULL
				OR EXISTS (
					SELECT 1 FROM listing_label_state_expiry expiry
					WHERE expiry.src = redaction.src
					  AND expiry.uri = redaction.uri
					  AND expiry.val = redaction.val
					  AND expiry.exp = redaction.exp
					  AND expiry.exp_epoch > unixepoch('now')
				)
			  ))
			OR (redaction.collision = 1 AND (
				EXISTS (
					SELECT 1 FROM listing_labels candidate
					WHERE candidate.src = redaction.src
					  AND candidate.uri = redaction.uri
					  AND candidate.val = redaction.val
					  AND candidate.cts_epoch = redaction.cts_epoch
					  AND candidate.cts_fraction = redaction.cts_fraction
					  AND candidate.neg = 0
					  AND (
						(candidate.val = 'listing-blocked'
						  AND candidate.cid = json_extract(r.signature_metadata, '$.cid'))
						OR (candidate.val IN ('!takedown', 'security:yanked', 'security-yanked') AND (
							candidate.cid IS NULL
							OR candidate.cid = json_extract(r.signature_metadata, '$.cid')
						))
					  )
					  AND (candidate.exp IS NULL OR candidate.exp_epoch > unixepoch('now'))
				)
				OR (NOT EXISTS (
					SELECT 1 FROM listing_labels candidate
					WHERE candidate.src = redaction.src
					  AND candidate.uri = redaction.uri
					  AND candidate.val = redaction.val
					  AND candidate.cts_epoch = redaction.cts_epoch
					  AND candidate.cts_fraction = redaction.cts_fraction
				) AND (
					(redaction.val = 'listing-blocked'
					  AND redaction.cid = json_extract(r.signature_metadata, '$.cid'))
					OR (redaction.val IN ('!takedown', 'security:yanked', 'security-yanked') AND (
						redaction.cid IS NULL
						OR redaction.cid = json_extract(r.signature_metadata, '$.cid')
					))
				))
			))
		  )
	)
	AND NOT EXISTS (
		SELECT 1 FROM listing_replay_restrictions replay
		JOIN labellers source ON source.did = replay.src
		WHERE source.active = 1 AND source.replay_pending = 1
		  AND replay.uri = 'at://' || r.did || '/${NSID.packageRelease}/' || r.rkey
		  AND (
			(replay.val = 'listing-blocked'
			  AND (source.required_positive = 1 OR source.accepted_state = 1))
			OR (replay.val IN ('!takedown', 'security:yanked', 'security-yanked')
			  AND source.redaction = 1)
		  )
		  AND (replay.exp_epoch IS NULL OR replay.exp_epoch > unixepoch('now'))
		  AND (
			(replay.val = 'listing-blocked'
			  AND replay.cid = json_extract(r.signature_metadata, '$.cid'))
			OR (replay.val IN ('!takedown', 'security:yanked', 'security-yanked') AND (
				replay.cid IS NULL
				OR replay.cid = json_extract(r.signature_metadata, '$.cid')
			))
		  )
	)
`;

export const ALLOWLIST_PROFILE_SQL = `
	EXISTS (
		SELECT 1 FROM json_each(?) listing_allowlist
		WHERE listing_allowlist.value =
			'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
	)
`;
