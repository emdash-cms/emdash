/**
 * Calendar page
 *
 * Published and scheduled entries across collections, placed by day in the
 * site's time zone.
 */

import { Banner, Button, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { CalendarAgenda } from "../components/calendar/CalendarAgenda.js";
import { CalendarDragProvider } from "../components/calendar/CalendarDrag.js";
import { CalendarEntryPanel } from "../components/calendar/CalendarEntryPanel.js";
import { CalendarFilters } from "../components/calendar/CalendarFilters.js";
import { CalendarMonth } from "../components/calendar/CalendarMonth.js";
import { CalendarToolbar } from "../components/calendar/CalendarToolbar.js";
import { getMutationError } from "../components/DialogError.js";
import { visibleCollectionEntries } from "../components/Sidebar.js";
import {
	CALENDAR_MAX_ENTRIES,
	calendarEntryKey,
	calendarQueryOptions,
} from "../lib/api/calendar.js";
import { ApiResponseError, fetchManifest, type AdminManifest } from "../lib/api/client.js";
import { scheduleContent } from "../lib/api/content.js";
import { useCurrentUser } from "../lib/api/current-user.js";
import {
	canPublishEntry,
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
import { cn } from "../lib/utils.js";
import { useDateLocale } from "../locales/date-locale.js";

const REFRESH_MS = 60_000;
/** Below this width the month grid's cells get too narrow, so the calendar uses its compact layout. */
const COMPACT_WIDTH = 640;
/**
 * Extra room needed to leave the compact layout. A scrollbar that appears
 * with the taller grid narrows the page, which would otherwise flip it back.
 */
const COMPACT_SLACK = 24;
/** From this width the side panel sits beside the calendar instead of over it. */
const DOCK_WIDTH = 1000;
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

/**
 * Shortcuts don't fire while typing, inside menus and lists that use letter
 * keys themselves, or behind the phone's entry sheet.
 */
const SHORTCUT_IGNORE =
	"input, textarea, select, [contenteditable], [role=menu], [role=listbox], [role=combobox], [aria-modal=true]";

const LATIN_LETTER = /^[a-z]$/i;
const LETTER_KEY_CODE = /^Key([A-Z])$/;

/**
 * The letter a key press means: the printed letter on Latin layouts, and the
 * letter at that position on others, such as Cyrillic.
 */
function shortcutLetter(event: KeyboardEvent): string | undefined {
	if (LATIN_LETTER.test(event.key)) return event.key.toLowerCase();
	return LETTER_KEY_CODE.exec(event.code)?.[1]?.toLowerCase();
}

/** Runs the handler for a letter key pressed on its own. */
function useShortcuts(handlers: Partial<Record<string, () => void>>) {
	const latest = React.useRef(handlers);
	React.useLayoutEffect(() => {
		latest.current = handlers;
	});
	React.useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat) return;
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
			if (event.target instanceof Element && event.target.closest(SHORTCUT_IGNORE)) return;
			const letter = shortcutLetter(event);
			const handler = letter && latest.current[letter];
			if (!handler) return;
			event.preventDefault();
			handler();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
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
	const docked = !useNarrow(containerRef, DOCK_WIDTH);
	const [dock, setDock] = React.useState<HTMLDivElement | null>(null);

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
	const changeView = (next: CalendarView) => updateSearch({ view: next });
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

	const toastManager = useKumoToastManager();
	const canMove = React.useCallback(
		(item: CalendarItem) => item.kind === "scheduled" && canPublishEntry(user, item.authorId),
		[user],
	);
	const refreshContent = (collection: string) => {
		void queryClient.invalidateQueries({ queryKey: ["calendar"] });
		void queryClient.invalidateQueries({ queryKey: ["content", collection] });
		void queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
	};
	const placeEntry = (
		queryKey: ReturnType<typeof calendarQueryOptions>["queryKey"],
		key: string,
		at: string,
	) =>
		queryClient.setQueryData(queryKey, (data) =>
			data
				? {
						...data,
						items: data.items.map((entry) =>
							calendarEntryKey(entry) === key ? { ...entry, at } : entry,
						),
					}
				: data,
		);
	const move = useMutation({
		mutationFn: ({
			item,
			scheduledAt,
		}: {
			item: CalendarItem;
			scheduledAt: string;
			undo?: boolean;
		}) => scheduleContent(item.collection, item.id, scheduledAt, { locale: item.locale }),
		onMutate: async ({ item, scheduledAt }) => {
			const { queryKey } = calendarQueryOptions(range.from, range.to);
			await queryClient.cancelQueries({ queryKey: ["calendar"] });
			const previousAt = queryClient
				.getQueryData(queryKey)
				?.items.find((entry) => calendarEntryKey(entry) === item.key)?.at;
			placeEntry(queryKey, item.key, scheduledAt);
			return { queryKey, previousAt };
		},
		onError: (moveError, { item }, context) => {
			// Other moves may still be on their way, so only this entry goes back.
			if (context?.previousAt) placeEntry(context.queryKey, item.key, context.previousAt);
			toastManager.add({
				title: t`Could not reschedule`,
				description: getMutationError(moveError),
				type: "error",
			});
		},
		onSuccess: (_changed, { item, scheduledAt, undo }) => {
			const title = item.title;
			const when = display.formatDateTime(Date.parse(scheduledAt));
			const toastId: string = toastManager.add({
				title: t`Rescheduled`,
				description: t`${title} now goes live ${when}.`,
				// A time that has passed can't be scheduled again.
				actions:
					undo || item.time <= Date.now()
						? undefined
						: [
								{
									children: t`Undo`,
									onClick: () => {
										toastManager.close(toastId);
										move.mutate({ item, scheduledAt: item.at, undo: true });
									},
								},
							],
			});
		},
		onSettled: (_changed, _error, { item }) => refreshContent(item.collection),
	});
	const rejectPastDrop = () => {
		toastManager.add({
			title: t`That time has passed`,
			description: t`Drop the entry on a later day.`,
			type: "error",
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
	const cutOffDay = loadedThrough && display.monthDay(loadedThrough);

	const showPrevious = () => goToMonth(shiftMonth(month, -1));
	const showNext = () => goToMonth(shiftMonth(month, 1));
	const showToday = () => goToMonth(undefined);
	useShortcuts({
		t: showToday,
		j: showNext,
		k: showPrevious,
		m: () => changeView("month"),
		a: () => changeView("agenda"),
	});

	return (
		<div ref={containerRef} className="flex h-full min-w-0">
			<div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
				<h1 className="sr-only">{t`Calendar`}</h1>
				<CalendarToolbar
					title={display.monthTitle(month)}
					display={display}
					zoneTime={dayKeyToUTC(`${month}-15`) + 12 * 3_600_000}
					loading={calendar.isPending && calendar.isFetching}
					view={view}
					onViewChange={changeView}
					onPrevious={showPrevious}
					onNext={showNext}
					onToday={showToday}
					onPreviewPrevious={() => prefetchMonth(shiftMonth(month, -1))}
					onPreviewNext={() => prefetchMonth(shiftMonth(month, 1))}
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

				<CalendarDragProvider
					display={display}
					now={now}
					onMove={(item, scheduledAt) => move.mutate({ item, scheduledAt })}
					onPastDrop={rejectPastDrop}
				>
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
								canMove={canMove}
								onMonthChange={goToMonth}
								onClearFilters={filtered ? clearFilters : undefined}
							/>
						) : (
							<div className="min-h-0 flex-1 overflow-y-auto">
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
							</div>
						))}
				</CalendarDragProvider>
			</div>

			{docked && (
				<div
					ref={setDock}
					className={cn(
						"h-full shrink-0 overflow-hidden border-kumo-line transition-[width] duration-200 ease-out motion-reduce:transition-none",
						selectedItem ? "w-96 border-s" : "w-0",
					)}
				/>
			)}
			{(!docked || dock) && (
				<CalendarEntryPanel
					item={selectedItem}
					dock={docked ? dock : null}
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
			)}
		</div>
	);
}
