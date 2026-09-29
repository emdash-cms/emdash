/**
 * Calendar page
 *
 * Published and scheduled entries across collections, placed by day in the
 * site's time zone.
 */

import { Banner, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ListBullets, WarningCircle } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { CalendarAgenda } from "../components/calendar/CalendarAgenda.js";
import { CalendarToolbar } from "../components/calendar/CalendarToolbar.js";
import { PageHeader } from "../components/PageHeader.js";
import { visibleCollectionEntries } from "../components/Sidebar.js";
import { CALENDAR_MAX_ENTRIES, calendarQueryOptions } from "../lib/api/calendar.js";
import { ApiResponseError, fetchManifest, type AdminManifest } from "../lib/api/client.js";
import {
	createCalendarDisplay,
	dayKeyInZone,
	fetchRange,
	groupByDay,
	isMonthKey,
	monthGridDays,
	shiftMonth,
	toCalendarItems,
	type CalendarState,
} from "../lib/calendar.js";
import { getDayPickerLocale } from "../locales/day-picker.js";

const REFRESH_MS = 60_000;

/** The current time, updated at each minute boundary. */
function useNow(): number {
	const [now, setNow] = React.useState(() => Date.now());
	React.useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			timer = setTimeout(
				() => {
					setNow(Date.now());
					tick();
				},
				60_000 - (Date.now() % 60_000),
			);
		};
		tick();
		return () => clearTimeout(timer);
	}, []);
	return now;
}

export function CalendarPage() {
	const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: fetchManifest });
	if (!manifest) return null;
	return <Calendar manifest={manifest} />;
}

function Calendar({ manifest }: { manifest: AdminManifest }) {
	const { t, i18n } = useLingui();
	const search = useSearch({ from: "/_admin/calendar" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const now = useNow();

	const collections = React.useMemo(
		() =>
			visibleCollectionEntries(manifest.collections).map(([slug, collection]) => ({
				slug,
				label: collection.label,
			})),
		[manifest.collections],
	);
	const collectionOrder = React.useMemo(
		() => collections.map((collection) => collection.slug),
		[collections],
	);
	const showLocale = (manifest.i18n?.locales.length ?? 0) > 1;
	const display = React.useMemo(
		() =>
			createCalendarDisplay({
				locale: i18n.locale,
				timeZone: manifest.timezone,
				collections,
				showLocale,
			}),
		[i18n.locale, manifest.timezone, collections, showLocale],
	);

	const today = dayKeyInZone(now, display.timeZone);
	const month = search.month ?? today.slice(0, 7);
	const weekStartsOn = getDayPickerLocale(i18n.locale).options?.weekStartsOn ?? 0;
	const range = React.useMemo(
		() => fetchRange(monthGridDays(month, weekStartsOn)),
		[month, weekStartsOn],
	);
	const rangeHasNow = now >= Date.parse(range.from) && now < Date.parse(range.to);

	const calendar = useQuery({
		...calendarQueryOptions(range.from, range.to),
		staleTime: 0,
		refetchInterval: (query) =>
			rangeHasNow && query.state.status !== "error" ? REFRESH_MS : false,
	});

	const items = React.useMemo(
		() =>
			calendar.data
				? toCalendarItems(calendar.data.items, {
						timeZone: display.timeZone,
						now,
						collectionOrder,
					})
				: [],
		[calendar.data, display.timeZone, now, collectionOrder],
	);
	const days = React.useMemo(() => groupByDay(items), [items]);
	const counts = React.useMemo(() => {
		if (!calendar.data) return undefined;
		const result: Record<CalendarState, number> = {
			published: 0,
			scheduled: 0,
			update: 0,
			overdue: 0,
		};
		for (const item of items) if (item.day.startsWith(month)) result[item.state] += 1;
		return result;
	}, [calendar.data, items, month]);

	const goToMonth = (next: string | undefined) => {
		if (next !== undefined && !isMonthKey(next)) return;
		void navigate({
			to: "/calendar",
			search: (previous) => ({ ...previous, month: next }),
			replace: true,
		});
	};
	const prefetchMonth = (target: string) => {
		if (!isMonthKey(target)) return;
		const targetRange = fetchRange(monthGridDays(target, weekStartsOn));
		void queryClient.prefetchQuery({
			...calendarQueryOptions(targetRange.from, targetRange.to),
			staleTime: REFRESH_MS,
		});
	};

	const error = calendar.error;
	const errorMessage =
		error instanceof ApiResponseError
			? error.code === "FORBIDDEN"
				? t`You don't have permission to view the calendar.`
				: error.message
			: t`Check your connection and try again.`;
	const maxEntries = new Intl.NumberFormat(i18n.locale).format(CALENDAR_MAX_ENTRIES);

	return (
		<div className="grid min-w-0 gap-6">
			<PageHeader
				title={t`Calendar`}
				description={t`Published and scheduled entries across collections, in the site's time zone.`}
				value="agenda"
				onValueChange={() => {}}
				tabs={[
					{
						value: "agenda",
						className: "flex-1 justify-center text-sm sm:flex-none",
						label: (
							<span className="flex items-center gap-1.5">
								<ListBullets className="size-4 shrink-0" weight="fill" aria-hidden="true" />
								{t`Agenda`}
							</span>
						),
					},
				]}
			/>

			<CalendarToolbar
				title={display.monthTitle(month)}
				display={display}
				loading={calendar.isPending && calendar.isFetching}
				counts={counts}
				onPrevious={() => goToMonth(shiftMonth(month, -1))}
				onNext={() => goToMonth(shiftMonth(month, 1))}
				onToday={() => goToMonth(undefined)}
				onPreviewPrevious={() => prefetchMonth(shiftMonth(month, -1))}
				onPreviewNext={() => prefetchMonth(shiftMonth(month, 1))}
			/>

			{error && (
				<Banner
					variant="error"
					icon={<WarningCircle aria-hidden="true" />}
					title={t`Could not load the calendar`}
					description={errorMessage}
					action={
						<Button variant="secondary" size="sm" onClick={() => void calendar.refetch()}>
							{t`Retry`}
						</Button>
					}
				/>
			)}
			{calendar.data?.truncated && (
				<Banner
					variant="alert"
					title={t`This range has more than ${maxEntries} entries. The calendar shows the first ${maxEntries}.`}
				/>
			)}

			{!(error && !calendar.data) && (
				<CalendarAgenda
					key={month}
					month={month}
					days={days}
					today={today}
					now={now}
					display={display}
					loading={!calendar.data}
				/>
			)}
		</div>
	);
}
