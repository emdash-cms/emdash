import { Badge, Tooltip } from "@cloudflare/kumo";
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

const COLLECTION_DOTS: Record<CollectionColor, string> = {
	blue: "bg-kumo-badge-blue",
	purple: "bg-kumo-badge-purple",
	teal: "bg-kumo-badge-teal",
	green: "bg-kumo-badge-green",
	neutral: "bg-kumo-badge-neutral",
};

const COLLECTION_TINTS: Record<CollectionColor, string> = {
	blue: "bg-kumo-badge-blue/15",
	purple: "bg-kumo-badge-purple/15",
	teal: "bg-kumo-badge-teal/15",
	green: "bg-kumo-badge-green/15",
	neutral: "bg-kumo-fill",
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

export function CalendarCollectionDot({
	color,
	className,
}: {
	color: CollectionColor;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-1.5 shrink-0 rounded-full", COLLECTION_DOTS[color], className)}
		/>
	);
}

/** A collection's name on its tint, the way the grid colors its dots. */
export function CalendarCollectionTag({
	slug,
	display,
	className,
}: {
	slug: string;
	display: CalendarDisplay;
	className?: string;
}) {
	const { label, color } = display.collection(slug);
	return (
		<Badge
			variant="secondary"
			className={cn("max-w-40 rounded-sm text-kumo-default", COLLECTION_TINTS[color], className)}
		>
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
	if (item.state === "update") return t`Update`;
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
	const viewerTime = display.viewerZoneDiffers ? display.formatViewerTime(item.time) : null;

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
			className={cn(
				"grid scroll-mt-12 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand aria-[current=true]:bg-kumo-tint motion-reduce:transition-none",
				display.viewerZoneDiffers
					? "@lg:grid-cols-[8.5rem_minmax(0,1fr)_auto]"
					: "@lg:grid-cols-[5rem_minmax(0,1fr)_auto]",
			)}
		>
			<span className="row-span-2 self-start leading-5 text-kumo-subtle tabular-nums @lg:row-span-1 @lg:self-center">
				{display.formatTime(item.time)}
				{viewerTime && <span className="hidden text-xs leading-4 @lg:block">{viewerTime}</span>}
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
				{viewerTime && (
					<span className="text-xs text-kumo-subtle tabular-nums @lg:hidden">{viewerTime}</span>
				)}
				<CalendarCollectionTag slug={item.collection} display={display} />
				{display.showLocale && <CalendarLocaleChip locale={item.locale} />}
			</span>
		</Link>
	);
}

function CalendarEntryDetails({ item, display }: { item: CalendarItem; display: CalendarDisplay }) {
	const { t } = useLingui();
	const { label, color } = display.collection(item.collection);
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
				<CalendarCollectionDot color={color} />
				{label}
				{display.showLocale && <CalendarLocaleChip locale={item.locale} />}
			</span>
		</span>
	);
}

/**
 * A month-cell entry linking to the editor. Published entries lie flat;
 * scheduled ones are raised cards, and overdue cards turn warning-tinted.
 */
export function CalendarEntryChip({
	item,
	display,
	now,
	selected,
	onSelect,
}: {
	item: CalendarItem;
	display: CalendarDisplay;
	now: number;
	selected?: boolean;
	onSelect?: CalendarSelectHandler;
}) {
	const { t } = useLingui();
	const { label, color } = display.collection(item.collection);
	const state = t(CALENDAR_STATE_LABELS[item.state]);
	const time = display.formatTime(item.time);
	const flat = item.state === "published";
	const overdue = item.state === "overdue";
	const lateness = overdue ? formatShortDuration(now - item.time, display.locale) : "";

	const link = (
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
			className={cn(
				"min-w-0 text-xs transition-[background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-kumo-brand motion-reduce:transition-none",
				flat
					? "flex items-center gap-1.5 rounded px-1.5 py-0.5 text-kumo-subtle hover:bg-kumo-tint aria-[current=true]:bg-kumo-tint"
					: "grid gap-0.5 overflow-hidden rounded-md px-2 py-1.5 shadow-xs ring-1 hover:shadow-sm aria-[current=true]:ring-2 aria-[current=true]:ring-kumo-brand",
				!flat &&
					(overdue
						? "bg-kumo-warning-tint ring-kumo-warning/30 hover:ring-kumo-warning/50"
						: "bg-kumo-base ring-kumo-line hover:ring-kumo-interact"),
			)}
		>
			{flat ? (
				<>
					<CalendarStateIcon state={item.state} className="size-3.5" />
					<span className="sr-only">{t`${state}, ${time}:`}</span>
					<span dir="auto" className="truncate">
						{item.title}
					</span>
				</>
			) : (
				<>
					<span dir="auto" className="truncate font-medium text-kumo-default">
						{item.title}
					</span>
					<span className="flex min-w-0 items-center gap-1 text-kumo-subtle">
						<CalendarStateIcon state={item.state} className="size-3.5" />
						<span className="shrink-0 tabular-nums">{time}</span>
						{overdue ? (
							<>
								<span className="sr-only">{state}</span>
								<span className="truncate font-medium text-kumo-warning">{t`${lateness} late`}</span>
							</>
						) : (
							<>
								<span className="sr-only">{state}</span>
								<CalendarCollectionDot color={color} className="ms-0.5" />
								<span className="hidden truncate @min-[8.5rem]:inline">{label}</span>
							</>
						)}
						{display.showLocale && (
							<span className="ms-auto">
								<CalendarLocaleChip locale={item.locale} />
							</span>
						)}
					</span>
				</>
			)}
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
