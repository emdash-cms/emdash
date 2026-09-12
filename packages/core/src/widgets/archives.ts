export type ArchiveGroupType = "monthly" | "yearly";

export interface ArchiveGroup {
	label: string;
	count: number;
	url: string;
}

function toPublishedDate(value: unknown): Date | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

/**
 * Group collection entries by published date for the Archives widget.
 *
 * Accepts `Date` objects, ISO strings, and numeric timestamps; `getEmDashCollection()`
 * returns `publishedAt` as a `Date`.
 */
export function groupEntriesByPublishedAt(
	entries: Array<{ data: { publishedAt?: unknown } }>,
	options: { type?: ArchiveGroupType; limit?: number } = {},
): ArchiveGroup[] {
	const type = options.type ?? "monthly";
	const limit = options.limit ?? 12;
	const archives = new Map<string, { date: Date; count: number; url: string }>();

	for (const entry of entries) {
		const date = toPublishedDate(entry.data.publishedAt);
		if (!date) continue;

		let key: string;
		let url: string;

		if (type === "yearly") {
			const year = date.getFullYear();
			key = `${year}`;
			url = `/archives/${year}`;
		} else {
			const year = date.getFullYear();
			const month = date.getMonth() + 1;
			key = `${year}-${month.toString().padStart(2, "0")}`;
			url = `/archives/${year}/${month.toString().padStart(2, "0")}`;
		}

		const existing = archives.get(key);
		if (existing) {
			existing.count++;
		} else {
			archives.set(key, { date, count: 1, url });
		}
	}

	return [...archives.values()].slice(0, limit).map(({ date, count, url }) => ({
		label:
			type === "yearly"
				? `${date.getFullYear()}`
				: date.toLocaleDateString("en-US", { year: "numeric", month: "long" }),
		count,
		url,
	}));
}
