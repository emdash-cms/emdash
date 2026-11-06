import { Button, Loader, Tabs } from "@cloudflare/kumo";
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
				<div className="flex h-7 shrink-0 items-center gap-1">
					{loading && <Loader size="sm" aria-label={t`Loading`} className="me-1" />}
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						aria-label={t`Previous month`}
						icon={<CaretPrev aria-hidden="true" />}
						onClick={onPrevious}
						onPointerEnter={onPreviewPrevious}
						onFocus={onPreviewPrevious}
					/>
					<Button variant="secondary" size="sm" onClick={onToday}>
						{t`Today`}
					</Button>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						aria-label={t`Next month`}
						icon={<CaretNext aria-hidden="true" />}
						onClick={onNext}
						onPointerEnter={onPreviewNext}
						onFocus={onPreviewNext}
					/>
				</div>
			</div>
		</div>
	);
}
