/**
 * Calendar API
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { queryOptions } from "@tanstack/react-query";

import { API_BASE, apiFetch, isTerminalRequestError, parseApiResponse } from "./client.js";

export interface CalendarEntry {
	collection: string;
	id: string;
	locale: string;
	title: string;
	/** The entry's current status. */
	status: string;
	/** `published` events sit at `published_at`, `scheduled` events at `scheduled_at`. */
	kind: "published" | "scheduled";
	at: string;
}

export interface CalendarPage {
	items: CalendarEntry[];
	nextCursor?: string;
}

export interface CalendarRange {
	items: CalendarEntry[];
	/** More events exist than the page cap allows the calendar to load. */
	truncated: boolean;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
export const CALENDAR_MAX_ENTRIES = PAGE_SIZE * MAX_PAGES;

export async function fetchCalendarPage(
	params: { from: string; to: string; cursor?: string },
	signal?: AbortSignal,
): Promise<CalendarPage> {
	const search = new URLSearchParams({
		from: params.from,
		to: params.to,
		limit: String(PAGE_SIZE),
	});
	if (params.cursor) search.set("cursor", params.cursor);
	const response = await apiFetch(`${API_BASE}/calendar?${search.toString()}`, { signal });
	return parseApiResponse<CalendarPage>(response, i18n._(msg`Failed to load the calendar`));
}

export function calendarEntryKey(entry: Pick<CalendarEntry, "collection" | "id" | "kind">): string {
	return `${entry.collection}:${entry.id}:${entry.kind}`;
}

/**
 * Loads every event in the range, up to the page cap. Entries rescheduled
 * while the pages load can come back twice, so repeats are dropped.
 */
export async function fetchCalendarRange(
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<CalendarRange> {
	const items: CalendarEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		// oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
		const result = await fetchCalendarPage({ from, to, cursor }, signal);
		for (const item of result.items) {
			const key = calendarEntryKey(item);
			if (seen.has(key)) continue;
			seen.add(key);
			items.push(item);
		}
		cursor = result.nextCursor;
		if (!cursor) return { items, truncated: false };
	}
	return { items, truncated: true };
}

export function calendarQueryOptions(from: string, to: string) {
	return queryOptions({
		queryKey: ["calendar", from, to] as const,
		queryFn: ({ signal }) => fetchCalendarRange(from, to, signal),
		retry: (failureCount, error) => !isTerminalRequestError(error) && failureCount < 1,
	});
}
