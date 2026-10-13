/**
 * Calendar page
 *
 * Published and scheduled entries across collections, placed by day in the
 * site's time zone.
 */

import { Banner, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { GridFour, ListBullets, WarningCircle } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { CalendarAgenda } from "../components/calendar/CalendarAgenda.js";
import { CalendarEntryPanel } from "../components/calendar/CalendarEntryPanel.js";
import { CalendarFilters } from "../components/calendar/CalendarFilters.js";
import { CalendarMonth } from "../components/calendar/CalendarMonth.js";
import { CalendarToolbar } from "../components/calendar/CalendarToolbar.js";
import { PageHeader } from "../components/PageHeader.js";
import { visibleCollectionEntries } from "../components/Sidebar.js";
import { CALENDAR_MAX_ENTRIES, calendarQueryOptions } from "../lib/api/calendar.js";
import { ApiResponseError, fetchManifest, type AdminManifest } from "../lib/api/client.js";
import { useCurrentUser } from "../lib/api/current-user.js";
import {
	createCalendarDisplay,
	dayKeyInZone,
	dayKeyToUTC,
	fetchRange,
	filterItems,
	groupByDay,
	isCalendarState,
	isMonthKey,
	monthGridDays,
	readList,
	shiftMonth,
	toCalendarItems,
	toListParam,
	type CalendarFilterValues,
	type CalendarItem,
	type CalendarSearch,
	type CalendarView,
} from "../lib/calendar.js";
import { useDateLocale } from "../locales/date-locale.js";

const REFRESH_MS = 60_000;
/** Below this width the month grid's cells get too narrow, so the calendar uses its compact layout. */
const COMPACT_WIDTH = 640;
/**
 * Extra room needed to leave the compact layout. A scrollbar that appears
 * with the taller grid narrows the page, which would otherwise flip it back.
 */
const COMPACT_SLACK = 24;
const NO_LOCALES: string[] = [];

/**
 * Whether the element is narrower than `width`. The sidebar takes part of the
 * viewport, so the calendar measures itself; the measurement runs before paint.
 */
function useNarrow(ref: React.RefObject<HTMLElement | null>, width: number): boolean {
	const [narrow, setNarrow] = React.useState(() => window.innerWidth < width);
	React.useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () =>
			setNarrow((wasNarrow) => element.clientWidth < width + (wasNarrow ? COMPACT_SLACK : 0));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, width]);
	return narrow;
}

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
	const router = useRouter();
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const now = useNow();
	const containerRef = React.useRef<HTMLDivElement>(null);
	const compact = useNarrow(containerRef, COMPACT_WIDTH);

	const collections = React.useMemo(
		() =>
			visibleCollectionEntries(manifest.collections).map(([slug, collection]) => ({
				slug,
				label: collection.label,
				icon: collection.icon,
			})),
		[manifest.collections],
	);
	const collectionOrder = React.useMemo(
		() => collections.map((collection) => collection.slug),
		[collections],
	);
	const urlPatterns = React.useMemo(
		() =>
			Object.fromEntries(
				Object.entries(manifest.collections).map(([slug, collection]) => [
					slug,
					collection.urlPattern,
				]),
			),
		[manifest.collections],
	);
	const locales = manifest.i18n?.locales ?? NO_LOCALES;
	const showLocale = locales.length > 1;
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
	const view: CalendarView = search.view ?? (compact ? "agenda" : "month");
	const dateLocale = useDateLocale();
	const weekStartsOn = dateLocale.options?.weekStartsOn ?? 0;
	const gridDays = React.useMemo(() => monthGridDays(month, weekStartsOn), [month, weekStartsOn]);
	const range = React.useMemo(() => fetchRange(gridDays), [gridDays]);

	// Values that match no current option (a deleted collection in a shared link) are ignored.
	const filters: CalendarFilterValues = React.useMemo(
		() => ({
			collections: readList(search.collections).filter((slug) => collectionOrder.includes(slug)),
			locales: readList(search.locales).filter((locale) => locales.includes(locale)),
			states: readList(search.states).filter(isCalendarState),
		}),
		[search.collections, search.locales, search.states, collectionOrder, locales],
	);
	const filtered = filters.collections.length + filters.locales.length + filters.states.length > 0;
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
						loadedAt: calendar.dataUpdatedAt,
						collectionOrder,
					})
				: [],
		[calendar.data, calendar.dataUpdatedAt, display.timeZone, collectionOrder],
	);
	const visibleItems = React.useMemo(() => filterItems(items, filters), [items, filters]);
	// Pages load oldest first, so a truncated range is complete before its last loaded day.
	const loadedThrough = calendar.data?.truncated ? items.at(-1)?.day : undefined;
	const days = React.useMemo(() => groupByDay(visibleItems), [visibleItems]);
	const unfilteredDays = React.useMemo(
		() => (filtered ? groupByDay(items) : days),
		[filtered, items, days],
	);

	const updateSearch = (patch: Partial<CalendarSearch>, options?: { push?: boolean }) => {
		void navigate({
			to: "/calendar",
			search: (previous) => ({ ...previous, ...patch }),
			replace: !options?.push,
		});
	};

	// Opening the panel adds a history entry, so Back closes it; switching entries replaces it.
	const selectedKey = search.entry;
	const searchWithoutEntry = JSON.stringify({ ...search, entry: undefined });
	// The search the panel's own history entry was added over; closing goes back to it when nothing else changed.
	const pushedFromRef = React.useRef<string | null>(null);
	const returnFocusRef = React.useRef<HTMLElement | null>(null);
	React.useEffect(() => {
		if (selectedKey === undefined) pushedFromRef.current = null;
	}, [selectedKey]);
	const openEntry = (item: CalendarItem, element: HTMLElement) => {
		returnFocusRef.current = element;
		if (selectedKey === undefined) pushedFromRef.current = searchWithoutEntry;
		updateSearch({ entry: item.key }, { push: selectedKey === undefined });
	};
	const closeEntry = () => {
		const pushedFrom = pushedFromRef.current;
		pushedFromRef.current = null;
		if (pushedFrom === searchWithoutEntry) router.history.back();
		else updateSearch({ entry: undefined });
	};
	// A refetch after an action can briefly lack the entry, so the panel keeps the last copy until data settles.
	const found = selectedKey ? items.find((item) => item.key === selectedKey) : undefined;
	const [lastSelected, setLastSelected] = React.useState<CalendarItem>();
	if (found && found !== lastSelected) setLastSelected(found);
	const selectedItem = found ?? (lastSelected?.key === selectedKey ? lastSelected : undefined);
	const settled = Boolean(calendar.data) && !calendar.isFetching;
	const entryMissing = Boolean(selectedKey) && !found && settled;
	React.useEffect(() => {
		if (!entryMissing) return;
		void navigate({
			to: "/calendar",
			search: (previous) => ({ ...previous, entry: undefined }),
			replace: true,
		});
	}, [entryMissing, navigate]);
	const goToMonth = (next: string | undefined) => {
		if (next === undefined || isMonthKey(next)) updateSearch({ month: next });
	};
	const setFilters = (patch: Partial<CalendarFilterValues>) => {
		updateSearch({
			...(patch.collections && { collections: toListParam(patch.collections) }),
			...(patch.locales && { locales: toListParam(patch.locales) }),
			...(patch.states && { states: toListParam(patch.states) }),
		});
	};
	const filterTriggerRef = React.useRef<HTMLButtonElement>(null);
	// The notices offering this unmount once it runs, so focus moves to the Filter menu.
	const clearFilters = () => {
		setFilters({ collections: [], locales: [], states: [] });
		filterTriggerRef.current?.focus();
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
	const zoneTime = dayKeyToUTC(`${month}-15`) + 12 * 3_600_000;
	const cutOffDay = loadedThrough && display.monthDay(loadedThrough);

	return (
		<div ref={containerRef} className="grid min-w-0 gap-6">
			<PageHeader
				title={t`Calendar`}
				description={t`Published and scheduled entries across collections, in the site's time zone.`}
				value={view}
				onValueChange={(value) => {
					if (value === "month" || value === "agenda") updateSearch({ view: value });
				}}
				tabs={[
					{
						value: "month",
						className: "flex-1 justify-center text-sm sm:flex-none",
						label: (
							<span className="flex items-center gap-1.5">
								<GridFour
									className="size-4 shrink-0"
									weight={view === "month" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`Month`}
							</span>
						),
					},
					{
						value: "agenda",
						className: "flex-1 justify-center text-sm sm:flex-none",
						label: (
							<span className="flex items-center gap-1.5">
								<ListBullets
									className="size-4 shrink-0"
									weight={view === "agenda" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`Agenda`}
							</span>
						),
					},
				]}
				tools={
					<CalendarFilters
						display={display}
						collections={collections}
						locales={locales}
						value={filters}
						onChange={setFilters}
						triggerRef={filterTriggerRef}
					/>
				}
			/>

			<CalendarToolbar
				title={display.monthTitle(month)}
				display={display}
				zoneTime={zoneTime}
				loading={calendar.isPending && calendar.isFetching}
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
					title={t`This range has more than ${maxEntries} entries`}
					description={
						cutOffDay
							? t`The calendar shows the first ${maxEntries}, which end on ${cutOffDay}.`
							: t`The calendar shows the first ${maxEntries}.`
					}
				/>
			)}

			{!(error && !calendar.data) &&
				(view === "month" ? (
					<CalendarMonth
						month={month}
						gridDays={gridDays}
						days={days}
						unfilteredDays={unfilteredDays}
						today={today}
						now={now}
						display={display}
						loading={!calendar.data}
						loadedThrough={loadedThrough}
						compact={compact}
						selectedKey={selectedKey}
						onSelect={openEntry}
						onMonthChange={goToMonth}
						onClearFilters={filtered ? clearFilters : undefined}
					/>
				) : (
					<CalendarAgenda
						key={month}
						month={month}
						days={days}
						today={today}
						now={now}
						display={display}
						loading={!calendar.data}
						loadedThrough={loadedThrough}
						onClearFilters={filtered ? clearFilters : undefined}
						selectedKey={selectedKey}
						onSelect={openEntry}
					/>
				))}

			<CalendarEntryPanel
				item={selectedItem}
				display={display}
				now={now}
				compact={compact}
				i18n={manifest.i18n}
				urlPatterns={urlPatterns}
				user={user}
				returnFocus={returnFocusRef}
				onClose={closeEntry}
				onRescheduled={(_item, scheduledAt) => {
					const target = dayKeyInZone(Date.parse(scheduledAt), display.timeZone).slice(0, 7);
					if (target !== month) goToMonth(target);
				}}
			/>
		</div>
	);
}
