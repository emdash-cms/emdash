import { Badge, Tooltip } from "@cloudflare/kumo";
import { useDraggable } from "@dnd-kit/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowsClockwise,
	CalendarDots,
	CheckCircle,
	WarningCircle,
	type Icon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	formatShortDuration,
	formatTimeAgo,
	type CalendarDisplay,
	type CalendarItem,
	type CalendarState,
	type CollectionColor,
} from "../../lib/calendar.js";
import { cn } from "../../lib/utils.js";
import { getLocaleLabel } from "../../locales/index.js";
import { getCollectionNavIcon } from "../admin-navigation-icons.js";
import { NavIcon } from "../Sidebar.js";

const STATE_ICONS: Record<CalendarState, Icon> = {
	published: CheckCircle,
	scheduled: CalendarDots,
	update: ArrowsClockwise,
	overdue: WarningCircle,
};

const STATE_COLORS: Record<CalendarState, string> = {
	published: "text-kumo-success",
	scheduled: "text-kumo-info",
	update: "text-kumo-info",
	overdue: "text-kumo-warning",
};

export const CALENDAR_STATE_LABELS: Record<CalendarState, MessageDescriptor> = {
	published: msg`Published`,
	scheduled: msg`Scheduled`,
	update: msg`Update scheduled`,
	overdue: msg`Overdue`,
};

const UPDATE_STATE_NOTE = msg({
	message: "Update",
	context: "A published entry's scheduled changes",
});

const COLLECTION_TINTS: Record<CollectionColor, string> = {
	blue: "bg-kumo-badge-blue/15",
	purple: "bg-kumo-badge-purple/15",
	teal: "bg-kumo-badge-teal/15",
	green: "bg-kumo-badge-green/15",
	neutral: "bg-kumo-fill",
};

const COLLECTION_HOVER_TINTS: Record<CollectionColor, string> = {
	blue: "hover:bg-kumo-badge-blue/25",
	purple: "hover:bg-kumo-badge-purple/25",
	teal: "hover:bg-kumo-badge-teal/25",
	green: "hover:bg-kumo-badge-green/25",
	neutral: "hover:bg-kumo-tint",
};

/**
 * Whether a click on an entry link should open the side panel. Clicks with a
 * modifier key keep the link's default, so they open the editor in a new tab.
 */
export function isPlainClick(event: React.MouseEvent): boolean {
	return (
		!event.defaultPrevented &&
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey
	);
}

export function CalendarStateIcon({
	state,
	className,
}: {
	state: CalendarState;
	className?: string;
}) {
	const StateIcon = STATE_ICONS[state];
	return (
		<StateIcon
			aria-hidden="true"
			className={cn("size-4 shrink-0", STATE_COLORS[state], className)}
		/>
	);
}

/** The collection's icon from the sidebar. */
export function CalendarCollectionIcon({
	slug,
	display,
	className,
}: {
	slug: string;
	display: CalendarDisplay;
	className?: string;
}) {
	return (
		<NavIcon
			icon={getCollectionNavIcon(slug, display.collection(slug).icon)}
			isActive={false}
			className={cn("size-3.5 shrink-0", className)}
		/>
	);
}

/** A collection's icon and name on its tint. */
export function CalendarCollectionTag({
	slug,
	display,
}: {
	slug: string;
	display: CalendarDisplay;
}) {
	const { label, color } = display.collection(slug);
	return (
		<Badge
			variant="secondary"
			className={cn("max-w-40 gap-1 rounded-sm ps-1.5 text-kumo-default", COLLECTION_TINTS[color])}
		>
			<CalendarCollectionIcon slug={slug} display={display} />
			<span className="truncate">{label}</span>
		</Badge>
	);
}

export function CalendarLocaleChip({ locale }: { locale: string }) {
	return (
		<span className="shrink-0 rounded-sm bg-kumo-fill px-1 text-[10px] font-semibold leading-4 tracking-wide text-kumo-subtle uppercase">
			<span aria-hidden="true">{locale}</span>
			<span className="sr-only">{getLocaleLabel(locale)}</span>
		</span>
	);
}

/** The visible tag after a title: how late an overdue entry is, or that a schedule is an update. */
function useStateNote(item: CalendarItem, display: CalendarDisplay, now: number): string | null {
	const { t } = useLingui();
	if (item.state === "overdue") {
		const lateness = formatTimeAgo(now - item.time, display.locale);
		return t`Overdue · ${lateness}`;
	}
	if (item.state === "update") return t(UPDATE_STATE_NOTE);
	return null;
}

export function CalendarNowLine({ label, className }: { label?: string; className?: string }) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 text-xs font-semibold text-kumo-danger tabular-nums",
				className,
			)}
		>
			<span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-danger" />
			{label && <span>{label}</span>}
			<span aria-hidden="true" className="h-[1.5px] flex-1 rounded-full bg-kumo-danger" />
		</div>
	);
}

/**
 * Opens an entry in the side panel; the entry links stay real links to the
 * editor. `element` is where focus returns when the panel closes.
 */
export type CalendarSelectHandler = (item: CalendarItem, element: HTMLElement) => void;

interface CalendarEntryRowProps {
	item: CalendarItem;
	display: CalendarDisplay;
	now: number;
	selected?: boolean;
	onSelect?: CalendarSelectHandler;
}

/** An agenda row: time, state, title, collection, and locale, linking to the editor. */
export function CalendarEntryRow({
	item,
	display,
	now,
	selected,
	onSelect,
}: CalendarEntryRowProps) {
	const { t } = useLingui();
	const note = useStateNote(item, display, now);
	const published = item.state === "published";

	return (
		<Link
			to="/content/$collection/$id"
			params={{ collection: item.collection, id: item.id }}
			search={{ locale: item.locale }}
			aria-haspopup={onSelect ? "dialog" : undefined}
			aria-current={selected ? "true" : undefined}
			onClick={(event) => {
				if (!onSelect || !isPlainClick(event)) return;
				event.preventDefault();
				onSelect(item, event.currentTarget);
			}}
			className="grid scroll-mt-12 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand aria-[current=true]:bg-kumo-tint motion-reduce:transition-none @lg:grid-cols-[5rem_minmax(0,1fr)_auto]"
		>
			<span className="row-span-2 self-start leading-5 text-kumo-subtle tabular-nums @lg:row-span-1 @lg:self-center">
				{display.formatTime(item.time)}
			</span>
			<span className="flex min-w-0 items-center gap-2">
				<CalendarStateIcon state={item.state} />
				{item.state !== "overdue" && (
					<span className="sr-only">{t(CALENDAR_STATE_LABELS[item.state])}</span>
				)}
				<span
					dir="auto"
					className={cn(
						"truncate",
						published ? "text-kumo-subtle" : "font-medium text-kumo-default",
					)}
				>
					{item.title}
				</span>
				{note && (
					<span
						aria-hidden={item.state === "update" || undefined}
						className={cn(
							"shrink-0 text-xs font-medium",
							item.state === "overdue" ? "text-kumo-warning" : "text-kumo-info",
						)}
					>
						{note}
					</span>
				)}
			</span>
			<span className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 @lg:col-start-auto @lg:justify-end">
				<CalendarCollectionTag slug={item.collection} display={display} />
				{display.showLocale && <CalendarLocaleChip locale={item.locale} />}
			</span>
		</Link>
	);
}

function CalendarEntryDetails({ item, display }: { item: CalendarItem; display: CalendarDisplay }) {
	const { t } = useLingui();
	const { label } = display.collection(item.collection);
	const state = t(CALENDAR_STATE_LABELS[item.state]);
	const when = display.formatDateTime(item.time);
	const viewerTime = display.formatViewerTime(item.time);

	return (
		<span className="grid max-w-64 gap-1 py-0.5 text-xs text-kumo-subtle">
			<span dir="auto" className="text-sm font-medium text-kumo-default">
				{item.title}
			</span>
			<span className="flex items-center gap-1.5 text-kumo-default">
				<CalendarStateIcon state={item.state} className="size-3.5" />
				{t`${state} · ${when}`}
			</span>
			{display.viewerZoneDiffers && <span>{t`Your time: ${viewerTime}`}</span>}
			<span className="flex items-center gap-1.5">
				<CalendarCollectionIcon slug={item.collection} display={display} />
				{label}
				{display.showLocale && <CalendarLocaleChip locale={item.locale} />}
			</span>
		</span>
	);
}

function chipClassName(item: CalendarItem, display: CalendarDisplay): string {
	const { color } = display.collection(item.collection);
	return cn(
		// The time wraps onto a clipped second line when the whole title doesn't fit.
		"flex h-[22px] min-w-0 flex-wrap items-center gap-x-1.5 overflow-hidden rounded px-1.5 text-xs leading-[22px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kumo-brand aria-[current=true]:ring-2 aria-[current=true]:ring-kumo-brand aria-[current=true]:ring-inset motion-reduce:transition-none",
		item.state === "published"
			? "text-kumo-subtle hover:bg-kumo-tint aria-[current=true]:bg-kumo-tint"
			: item.state === "overdue"
				? "bg-kumo-warning-tint text-kumo-default hover:bg-kumo-warning/20"
				: cn("text-kumo-default", COLLECTION_TINTS[color], COLLECTION_HOVER_TINTS[color]),
	);
}

function ChipContent({
	item,
	display,
	now,
}: {
	item: CalendarItem;
	display: CalendarDisplay;
	now: number;
}) {
	const { t } = useLingui();
	const state = t(CALENDAR_STATE_LABELS[item.state]);
	const time = display.formatTime(item.time);
	const overdue = item.state === "overdue";
	const lateness = overdue ? formatShortDuration(now - item.time, display.locale) : "";

	return (
		<>
			<span className="flex h-[22px] min-w-0 flex-auto items-center gap-1">
				<CalendarStateIcon state={item.state} className="size-3.5" />
				<span className="sr-only">
					{overdue ? t`${state}, ${lateness} late, ${time}:` : t`${state}, ${time}:`}
				</span>
				<span dir="auto" className={cn("truncate", item.state !== "published" && "font-medium")}>
					{item.title}
				</span>
				{display.showLocale && <CalendarLocaleChip locale={item.locale} />}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"ms-auto shrink-0 tabular-nums",
					overdue ? "font-medium text-kumo-warning" : "text-kumo-subtle",
				)}
			>
				{overdue ? t`${lateness} late` : time}
			</span>
		</>
	);
}

interface CalendarEntryChipProps {
	item: CalendarItem;
	display: CalendarDisplay;
	now: number;
	selected?: boolean;
	onSelect?: CalendarSelectHandler;
	/** The entry can be dragged to another day. */
	movable?: boolean;
}

/**
 * A one-line month-cell entry linking to the editor: published entries lie
 * flat, scheduled ones take their collection's tint, and overdue ones turn
 * warning-tinted. It is 22px tall, which the month grid's row math relies on.
 */
export function CalendarEntryChip(props: CalendarEntryChipProps) {
	return props.movable ? <MovableEntryChip {...props} /> : <EntryChipLink {...props} />;
}

/**
 * A click handler that swallows the click a drag can end with, which would
 * otherwise open the dragged link.
 */
function useClickAfterDragGuard(isDragging: boolean) {
	const dragged = React.useRef(false);
	React.useEffect(() => {
		if (isDragging) {
			dragged.current = true;
			return;
		}
		const timer = setTimeout(() => {
			dragged.current = false;
		});
		return () => clearTimeout(timer);
	}, [isDragging]);
	return (event: React.MouseEvent) => {
		if (!dragged.current) return;
		event.preventDefault();
		event.stopPropagation();
	};
}

function MovableEntryChip(props: CalendarEntryChipProps) {
	const { setNodeRef, listeners, isDragging } = useDraggable({
		id: props.item.key,
		data: { item: props.item },
	});
	const onClickCapture = useClickAfterDragGuard(isDragging);

	return (
		<EntryChipLink
			{...props}
			linkRef={setNodeRef}
			linkProps={{ ...listeners, draggable: false, onClickCapture }}
			dragging={isDragging}
		/>
	);
}

function EntryChipLink({
	item,
	display,
	now,
	selected,
	onSelect,
	linkRef,
	linkProps,
	dragging,
}: CalendarEntryChipProps & {
	linkRef?: (element: HTMLElement | null) => void;
	linkProps?: React.HTMLAttributes<HTMLElement> & { draggable?: boolean };
	dragging?: boolean;
}) {
	const link = (
		<Link
			ref={linkRef}
			{...linkProps}
			to="/content/$collection/$id"
			params={{ collection: item.collection, id: item.id }}
			search={{ locale: item.locale }}
			aria-haspopup={onSelect ? "dialog" : undefined}
			aria-current={selected ? "true" : undefined}
			onClick={(event) => {
				if (!onSelect || !isPlainClick(event)) return;
				event.preventDefault();
				onSelect(item, event.currentTarget);
			}}
			className={cn(
				chipClassName(item, display),
				// A long press starts a drag on touch screens, not the link preview.
				linkRef && "[-webkit-touch-callout:none]",
				dragging && "opacity-40",
			)}
		>
			<ChipContent item={item} display={display} now={now} />
		</Link>
	);

	return (
		<Tooltip
			content={<CalendarEntryDetails item={item} display={display} />}
			render={link}
			className="cursor-pointer"
		/>
	);
}

/** The chip that follows the pointer while an entry is dragged. */
export function CalendarEntryChipPreview({
	item,
	display,
	now,
	allowed,
}: {
	item: CalendarItem;
	display: CalendarDisplay;
	now: number;
	/** Whether dropping here would move the entry. */
	allowed: boolean;
}) {
	return (
		<div
			className={cn(
				chipClassName(item, display),
				// The landing time matters most while dragging, so the title gives way to it.
				"max-w-56 flex-nowrap cursor-grabbing shadow-lg ring-1 ring-kumo-line",
				!allowed && "cursor-not-allowed opacity-60",
			)}
		>
			<ChipContent item={item} display={display} now={now} />
		</div>
	);
}

interface CalendarDayListProps {
	items: readonly CalendarItem[];
	display: CalendarDisplay;
	now: number;
	label: string;
	/** Draws the now line before the item at this index (or after the last). */
	nowAt?: number;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
	className?: string;
}

export function CalendarDayList({
	items,
	display,
	now,
	label,
	nowAt,
	selectedKey,
	onSelect,
	className,
}: CalendarDayListProps) {
	const { t } = useLingui();
	const time = display.formatTime(now);
	const nowLine =
		nowAt === undefined ? null : (
			<li key="now" className="px-2 py-1">
				<CalendarNowLine label={t`Now · ${time}`} />
			</li>
		);

	return (
		<ul aria-label={label} className={cn("@container grid gap-px", className)}>
			{items.map((item, index) => (
				<React.Fragment key={item.key}>
					{index === nowAt && nowLine}
					<li>
						<CalendarEntryRow
							item={item}
							display={display}
							now={now}
							selected={item.key === selectedKey}
							onSelect={onSelect}
						/>
					</li>
				</React.Fragment>
			))}
			{nowAt !== undefined && nowAt >= items.length && nowLine}
		</ul>
	);
}
