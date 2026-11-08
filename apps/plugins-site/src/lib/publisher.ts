import type { RegistryEntryData } from "@emdash-cms/registry-loader";

import { relativeUpdated } from "./registry.js";

type PackageView = RegistryEntryData["package"];
type PackageProfile = NonNullable<PackageView["profile"]>;

export type PublisherPackage = Pick<PackageView, "indexedAt"> & {
	profile?: Pick<PackageProfile, "lastUpdated"> | null;
};

export interface PublisherDate {
	datetime: string;
	label: string;
}

export interface PublisherSummary {
	count: number;
	countLabel: string;
	/** The earliest listing, as a month such as "Sep 2026". */
	listedSince?: PublisherDate;
	/** The most recent profile update, as `relativeUpdated` words it. */
	lastUpdated?: PublisherDate;
}

function extreme(values: (string | undefined)[], pick: "earliest" | "latest") {
	let best: { value: string; time: number } | undefined;
	for (const value of values) {
		if (!value) continue;
		const time = Date.parse(value);
		if (Number.isNaN(time)) continue;
		if (!best || (pick === "earliest" ? time < best.time : time > best.time)) {
			best = { value, time };
		}
	}
	return best;
}

const monthFormat = new Intl.DateTimeFormat("en", {
	month: "short",
	year: "numeric",
	timeZone: "UTC",
});

export function publisherSummary(
	packages: readonly PublisherPackage[],
	now: Date = new Date(),
): PublisherSummary {
	const count = packages.length;
	const listed = extreme(
		packages.map((plugin) => plugin.indexedAt),
		"earliest",
	);
	const updated = extreme(
		packages.map((plugin) => plugin.profile?.lastUpdated),
		"latest",
	);
	const updatedLabel = updated && relativeUpdated(updated.value, now);
	return {
		count,
		countLabel: count === 1 ? "1 plugin" : `${count} plugins`,
		listedSince: listed && {
			datetime: new Date(listed.time).toISOString().slice(0, 7),
			label: monthFormat.format(listed.time),
		},
		lastUpdated: updatedLabel ? { datetime: updated.value, label: updatedLabel } : undefined,
	};
}

/**
 * Splits a handle or DID after each `.` or `:`, so a long identity can wrap
 * between its labels instead of mid-word.
 */
export function identityParts(identity: string): string[] {
	return identity.match(/[^.:]+[.:]*|[.:]+/g) ?? [identity];
}
