/**
 * Release moderation evaluation over hydrated aggregator responses.
 *
 * The aggregator hydrates label state onto package and release views but
 * does not sign it for this client's consumption, so evaluation goes through
 * `@emdash-cms/registry-moderation`'s hydrated (structurally validated, not
 * cryptographically verified) entry point rather than the branded one.
 */

import {
	evaluateHydratedReleaseModeration,
	parseAcceptLabelersHeader,
	parseModerationLabel,
	InvalidAcceptLabelersHeaderError,
	PACKAGE_SCOPE_BLOCK_VALUES,
	RELEASE_BLOCK_VALUES,
	type AcceptedLabelerPolicy,
	type ModerationLabel,
	type ReleaseEligibility,
	type ReleaseModeration,
	type ReleaseSubjectContext,
} from "@emdash-cms/registry-moderation";

import type { ValidatedPackageView, ValidatedReleaseView } from "./discovery/index.js";

export {
	evaluateHydratedReleaseModeration,
	parseAcceptLabelersHeader,
	InvalidAcceptLabelersHeaderError,
	PACKAGE_SCOPE_BLOCK_VALUES,
	RELEASE_BLOCK_VALUES,
	type AcceptedLabelerPolicy,
	type ReleaseEligibility,
	type ReleaseModeration,
};

export interface ResolveAcceptedPolicyInput {
	/** The `acceptLabelers` value configured on the `DiscoveryClient`, if any. */
	configuredAcceptLabelers?: string;
	/** The `atproto-content-labelers` header from the aggregator's response, if any. */
	contentLabelersHeader?: string;
}

/**
 * Resolves the accepted-labeler policy to evaluate a response's moderation
 * state against. The response header takes precedence when present and
 * non-empty, since it reports what the aggregator actually applied; falling
 * back to the configured value, then to no client-side enforcement. A
 * malformed response header is an aggregator-side bug and is skipped with a
 * warning rather than failing the caller; a malformed configured value is an
 * operator misconfiguration and throws.
 */
export function resolveAcceptedPolicy(input: ResolveAcceptedPolicyInput): AcceptedLabelerPolicy[] {
	if (input.contentLabelersHeader) {
		try {
			return parseAcceptLabelersHeader(input.contentLabelersHeader);
		} catch (error) {
			console.warn(
				"[registry-client] ignoring malformed atproto-content-labelers response header:",
				error,
			);
		}
	}
	if (input.configuredAcceptLabelers) {
		return parseAcceptLabelersHeader(input.configuredAcceptLabelers);
	}
	return [];
}

export interface EvaluateReleaseViewsInput {
	packageView: ValidatedPackageView;
	releaseView: ValidatedReleaseView;
	publisherDid: string;
	accepted: AcceptedLabelerPolicy[];
	evaluatedAt?: Date;
}

/**
 * Assembles the release's moderation context from its package and release
 * views and evaluates the hydrated label state they carry. A label that
 * fails structural validation is skipped with a warning rather than failing
 * the whole evaluation -- one bad aggregator label must not block every
 * install.
 */
export function evaluateReleaseViews(input: EvaluateReleaseViewsInput): ReleaseModeration {
	const context: ReleaseSubjectContext = {
		publisherDid: input.publisherDid,
		package: { uri: input.packageView.uri, cid: input.packageView.cid },
		release: { uri: input.releaseView.uri, cid: input.releaseView.cid },
	};

	const rawLabels = [...(input.packageView.labels ?? []), ...(input.releaseView.labels ?? [])];
	const labels: ModerationLabel[] = [];
	for (const rawLabel of rawLabels) {
		try {
			labels.push(parseModerationLabel(rawLabel));
		} catch (error) {
			console.warn("[registry-client] skipping structurally invalid moderation label:", error);
		}
	}

	return evaluateHydratedReleaseModeration({
		acceptedLabelers: input.accepted,
		context,
		evaluatedAt: input.evaluatedAt ?? new Date(),
		labels,
	});
}
