import { Badge } from "@cloudflare/kumo";
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
	formatLateness,
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

export function CalendarCollectionTag({
	slug,
	display,
}: {
	slug: string;
	display: CalendarDisplay;
}) {
	const { label, color } = display.collection(slug);
	return (
		<Badge variant="secondary" className="max-w-40 gap-1.5">
			<CalendarCollectionDot color={color} />
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
		const lateness = formatLateness(now - item.time, display.locale);
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

interface CalendarEntryRowProps {
	item: CalendarItem;
	display: CalendarDisplay;
	now: number;
}

/** An agenda row: time, state, title, collection, and locale, linking to the editor. */
export function CalendarEntryRow({ item, display, now }: CalendarEntryRowProps) {
	const { t } = useLingui();
	const note = useStateNote(item, display, now);
	const published = item.state === "published";
	const viewerTime = display.viewerZoneDiffers ? display.formatViewerTime(item.time) : null;

	return (
		<Link
			to="/content/$collection/$id"
			params={{ collection: item.collection, id: item.id }}
			search={{ locale: item.locale }}
			className={cn(
				"grid scroll-mt-12 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand motion-reduce:transition-none",
				display.viewerZoneDiffers
					? "sm:grid-cols-[8.5rem_minmax(0,1fr)_auto]"
					: "sm:grid-cols-[5rem_minmax(0,1fr)_auto]",
			)}
		>
			<span className="row-span-2 self-start text-sm leading-5 text-kumo-subtle tabular-nums sm:row-span-1 sm:self-center">
				{display.formatTime(item.time)}
				{viewerTime && <span className="hidden text-xs leading-4 sm:block">{viewerTime}</span>}
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
			<span className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:col-start-auto sm:justify-end">
				{viewerTime && (
					<span className="text-xs text-kumo-subtle tabular-nums sm:hidden">{viewerTime}</span>
				)}
				<CalendarCollectionTag slug={item.collection} display={display} />
				{display.showLocale && <CalendarLocaleChip locale={item.locale} />}
			</span>
		</Link>
	);
}

interface CalendarDayListProps {
	items: readonly CalendarItem[];
	display: CalendarDisplay;
	now: number;
	label: string;
	/** Draws the now line before the item at this index (or after the last). */
	nowAt?: number;
	className?: string;
}

export function CalendarDayList({
	items,
	display,
	now,
	label,
	nowAt,
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
		<ul aria-label={label} className={cn("grid gap-px", className)}>
			{items.map((item, index) => (
				<React.Fragment key={item.key}>
					{index === nowAt && nowLine}
					<li>
						<CalendarEntryRow item={item} display={display} now={now} />
					</li>
				</React.Fragment>
			))}
			{nowAt !== undefined && nowAt >= items.length && nowLine}
		</ul>
	);
}
