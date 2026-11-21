import type { QueryClient } from "@tanstack/react-query";

const CONTENT_VIEW_PREFIXES = [
	"dashboard-stats",
	"calendar",
	"translations",
	"content-picker",
	"command-palette-search",
	"link-content-search",
] as const;

export async function invalidateContentViews(
	queryClient: QueryClient,
	preserveEntry?: { collection: string; id: string },
	refetchType: "active" | "none" = "active",
): Promise<void> {
	const invalidations = [
		queryClient.invalidateQueries({
			refetchType,
			predicate: ({ queryKey }) => {
				if (queryKey[0] !== "content") return false;
				// The editor owns detail updates so autosave cannot refetch over its in-progress form.
				return !(
					preserveEntry &&
					queryKey[1] === preserveEntry.collection &&
					queryKey[2] === preserveEntry.id
				);
			},
		}),
		...CONTENT_VIEW_PREFIXES.map((prefix) =>
			queryClient.invalidateQueries({ queryKey: [prefix], refetchType }),
		),
	];
	await Promise.all(invalidations);
}
