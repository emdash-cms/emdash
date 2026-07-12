/**
 * Registry moderation display for the CLI.
 *
 * The CLI never configures `acceptLabelers` -- there is no persisted
 * registry config here -- so the accepted policy always comes from the
 * aggregator's `atproto-content-labelers` response header (see
 * `resolveAcceptedPolicy`'s precedence).
 */

import {
	evaluateReleaseViews,
	isModerationBlocking,
	type AcceptedLabelerPolicy,
	type ReleaseModeration,
} from "@emdash-cms/registry-client";
import type {
	ValidatedPackageView,
	ValidatedReleaseView,
} from "@emdash-cms/registry-client/discovery";
import pc from "picocolors";

/**
 * Evaluates a package's package/publisher-scope moderation state without a
 * specific release in view -- used where fetching a release per package
 * would be too expensive (e.g. bulk search results). The stub release's
 * `uri`/`cid` can never match a real label, so release-scope automated
 * blocks and warnings are excluded by construction, not by omission.
 */
export function evaluatePackageModeration(
	packageView: ValidatedPackageView,
	accepted: AcceptedLabelerPolicy[],
): ReleaseModeration {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- `uri`/`cid` are branded FormattedStringSchema types; this stub is never a real record, only compared against label uris that can never equal these placeholders
	const releaseStub = {
		uri: "",
		cid: "",
		did: packageView.did,
		package: packageView.slug,
		version: "",
		indexedAt: packageView.indexedAt,
		release: null,
	} as unknown as ValidatedReleaseView;

	return evaluateReleaseViews({
		packageView,
		releaseView: releaseStub,
		publisherDid: packageView.did,
		accepted,
	});
}

/** Whether a moderation result should be surfaced as blocking to the user. */
export function isModerationBlocked(moderation: ReleaseModeration): boolean {
	return isModerationBlocking(moderation);
}

/**
 * Renders human-readable moderation lines for `info`/`search` output.
 * Returns an empty array when there's nothing worth showing -- an
 * eligibility of "blocked" driven solely by a missing positive assessment
 * (today's default; no labels flow in production yet) is not surfaced here.
 */
export function renderModerationLines(moderation: ReleaseModeration): string[] {
	const lines: string[] = [];
	if (isModerationBlocked(moderation)) {
		const sources = [
			...new Set(
				moderation.applicableLabels
					.filter((l) => moderation.blockingLabels.includes(l.val))
					.map((l) => l.src),
			),
		];
		const detail =
			moderation.blockingLabels.length > 0
				? moderation.blockingLabels.join(", ")
				: "redacted takedown";
		const bySources = sources.length > 0 ? ` by ${sources.join(", ")}` : "";
		lines.push(`Moderation: ${pc.red("blocked")} (${detail})${bySources}`);
	}
	if (moderation.warningLabels.length > 0) {
		lines.push(`  warnings: ${moderation.warningLabels.join(", ")}`);
	}
	return lines;
}
