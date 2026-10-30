import { Button, Loader, Tabs, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Globe, GridFour, ListBullets } from "@phosphor-icons/react";
import type * as React from "react";

import type { CalendarDisplay, CalendarView } from "../../lib/calendar.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";

interface CalendarToolbarProps {
	title: string;
	display: CalendarDisplay;
	/** An instant in the shown month, for zone names that change with daylight saving time. */
	zoneTime: number;
	loading: boolean;
	view: CalendarView;
	onViewChange: (view: CalendarView) => void;
	onPrevious: () => void;
	onNext: () => void;
	onToday: () => void;
	/** Called when the pointer or focus reaches a month button, before it is pressed. */
	onPreviewPrevious?: () => void;
	onPreviewNext?: () => void;
	/** The filters, across from the view switcher. */
	tools?: React.ReactNode;
}

function ShortcutHint({ label, shortcut }: { label: string; shortcut: string }) {
	return (
		<span className="flex items-center gap-2">
			{label}
			<kbd className="rounded border border-kumo-line px-1 font-sans text-[11px] leading-4 text-kumo-subtle">
				{shortcut}
			</kbd>
		</span>
	);
}

/**
 * The views and filters on the first row; the month, its time zone, and the
 * month buttons on the second.
 */
export function CalendarToolbar({
	title,
	display,
	zoneTime,
	loading,
	view,
	onViewChange,
	onPrevious,
	onNext,
	onToday,
	onPreviewPrevious,
	onPreviewNext,
	tools,
}: CalendarToolbarProps) {
	const { t } = useLingui();
	const siteZone = display.zoneShortName(zoneTime);
	const viewerZone = display.viewerZoneShortName(zoneTime);
	const showViewerZone = display.viewerZoneDiffers && viewerZone !== siteZone;
	const zoneName = display.zoneName;
	const viewerZoneName = display.viewerZoneName;
	const zoneDescription = showViewerZone
		? t`Times are in ${zoneName}. Your browser uses ${viewerZoneName}.`
		: t`Times are in ${zoneName}.`;
	const previousLabel = t`Previous month`;
	const nextLabel = t`Next month`;

	return (
		<div className="grid gap-3">
			<div className="flex items-center justify-between gap-2 border-b border-kumo-line pb-3">
				<Tabs
					value={view}
					onValueChange={(value) => {
						if (value === "month" || value === "agenda") onViewChange(value);
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
					className="min-w-0 flex-1 sm:flex-none"
					listClassName="w-full"
				/>
				<div className="flex shrink-0 items-center gap-2">{tools}</div>
			</div>
			<div className="flex items-start justify-between gap-4">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
					<h2 className="text-xl leading-7 font-semibold text-kumo-default">{title}</h2>
					<p
						title={zoneDescription}
						className="flex items-center gap-1.5 text-sm text-kumo-subtle tabular-nums"
					>
						<Globe aria-hidden="true" className="size-4 shrink-0 self-center" />
						<span aria-hidden="true">
							{showViewerZone ? t`${siteZone} · Your time: ${viewerZone}` : siteZone}
						</span>
						<span className="sr-only">{zoneDescription}</span>
					</p>
				</div>
				<TooltipProvider delay={600}>
					<div className="flex h-7 shrink-0 items-center gap-1">
						{loading && <Loader size="sm" aria-label={t`Loading`} className="me-1" />}
						<Tooltip
							content={<ShortcutHint label={previousLabel} shortcut="K" />}
							render={
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									aria-label={previousLabel}
									aria-keyshortcuts="K"
									icon={<CaretPrev aria-hidden="true" />}
									onClick={onPrevious}
									onPointerEnter={onPreviewPrevious}
									onFocus={onPreviewPrevious}
								/>
							}
						/>
						<Tooltip
							content={<ShortcutHint label={t`Go to today`} shortcut="T" />}
							render={
								<Button variant="secondary" size="sm" onClick={onToday} aria-keyshortcuts="T">
									{t`Today`}
								</Button>
							}
						/>
						<Tooltip
							content={<ShortcutHint label={nextLabel} shortcut="J" />}
							render={
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									aria-label={nextLabel}
									aria-keyshortcuts="J"
									icon={<CaretNext aria-hidden="true" />}
									onClick={onNext}
									onPointerEnter={onPreviewNext}
									onFocus={onPreviewNext}
								/>
							}
						/>
					</div>
				</TooltipProvider>
			</div>
		</div>
	);
}
