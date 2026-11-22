import type { RegistryEntryData } from "@emdash-cms/registry-loader";

type PackageView = RegistryEntryData["package"];
type PackageProfile = NonNullable<PackageView["profile"]>;

export type PackageSummary = Pick<PackageView, "did"> & {
	profile?: Pick<PackageProfile, "keywords" | "lastUpdated"> | null;
};

/**
 * Keywords on at least two plugins, the ones the most publishers use first,
 * then the ones on the most plugins. One publisher tagging many plugins can't
 * outrank a keyword many publishers share.
 */
export function popularKeywords(packages: readonly PackageSummary[], count: number): string[] {
	const publishers = new Map<string, Set<string>>();
	const uses = new Map<string, number>();
	for (const plugin of packages) {
		const keywords = new Set(
			(plugin.profile?.keywords ?? [])
				.map((keyword) => keyword.trim().toLowerCase())
				.filter(Boolean),
		);
		for (const keyword of keywords) {
			uses.set(keyword, (uses.get(keyword) ?? 0) + 1);
			const dids = publishers.get(keyword) ?? new Set<string>();
			dids.add(plugin.did);
			publishers.set(keyword, dids);
		}
	}
	const publisherCount = (keyword: string) => publishers.get(keyword)?.size ?? 0;
	return [...uses]
		.filter(([, total]) => total > 1)
		.toSorted(
			([a, aTotal], [b, bTotal]) =>
				publisherCount(b) - publisherCount(a) || bTotal - aTotal || a.localeCompare(b),
		)
		.slice(0, count)
		.map(([keyword]) => keyword);
}
