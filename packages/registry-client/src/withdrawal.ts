import {
	evaluateHydratedReleaseWithdrawal,
	parseListingLabel,
	type ListingLabelEvent,
	type ReleaseWithdrawalResult,
} from "@emdash-cms/registry-moderation";

import type { ValidatedReleaseView } from "./discovery/index.js";
import type { RegistryLabelerPolicy } from "./listing-policy.js";

export interface RegistryReleaseWithdrawalResult extends ReleaseWithdrawalResult {
	malformed: boolean;
}

export interface RegistryReleaseWithdrawalOptions {
	evaluatedAt?: Date | string;
}

function acceptedSources(policy: RegistryLabelerPolicy): string[] | undefined {
	if (!policy.acceptLabelers) return undefined;
	return policy.acceptLabelers
		.split(",")
		.map((entry) => entry.trim().split(";", 1)[0])
		.filter((source): source is string => Boolean(source));
}

/**
 * Evaluates hydrated release-withdrawal labels through the shared moderation
 * policy. Malformed hydrated labels fail closed instead of being skipped.
 */
export function evaluateRegistryReleaseWithdrawal(
	release: Pick<ValidatedReleaseView, "uri" | "cid" | "labels">,
	policy: RegistryLabelerPolicy,
	options: RegistryReleaseWithdrawalOptions = {},
): RegistryReleaseWithdrawalResult {
	const labels: ListingLabelEvent[] = [];
	try {
		for (const label of release.labels ?? []) labels.push(parseListingLabel(label));
	} catch {
		return { withdrawn: true, applicableLabels: [], malformed: true };
	}
	const result = evaluateHydratedReleaseWithdrawal({
		uri: release.uri,
		cid: release.cid,
		labels,
		evaluatedAt: options.evaluatedAt ?? new Date(),
		acceptedSources: acceptedSources(policy),
	});
	return { ...result, malformed: false };
}
