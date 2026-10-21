import type { RegistryEntryData } from "@emdash-cms/registry-loader";

type PackageView = RegistryEntryData["package"];
type PackageProfile = NonNullable<PackageView["profile"]>;

export type PackageSummary = Pick<PackageView, "did"> & {
	profile?: Pick<PackageProfile, "keywords" | "lastUpdated"> | null;
};

/** Keywords shared by at least two plugins, most used first. */
export function popularKeywords(packages: readonly PackageSummary[], count: number): string[] {
	const uses = new Map<string, number>();
	for (const plugin of packages) {
		const keywords = new Set(
			(plugin.profile?.keywords ?? [])
				.map((keyword) => keyword.trim().toLowerCase())
				.filter(Boolean),
		);
		for (const keyword of keywords) uses.set(keyword, (uses.get(keyword) ?? 0) + 1);
	}
	return [...uses]
		.filter(([, total]) => total > 1)
		.toSorted(([a, aTotal], [b, bTotal]) => bTotal - aTotal || a.localeCompare(b))
		.slice(0, count)
		.map(([keyword]) => keyword);
}
