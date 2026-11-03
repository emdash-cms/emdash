import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Globe } from "@phosphor-icons/react";

import type { CalendarDisplay } from "../../lib/calendar.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";

interface CalendarToolbarProps {
	title: string;
	display: CalendarDisplay;
	/** An instant in the shown month, for zone names that change with daylight saving time. */
	zoneTime: number;
	loading: boolean;
	onPrevious: () => void;
	onNext: () => void;
	onToday: () => void;
	/** Called when the pointer or focus reaches a month button, before it is pressed. */
	onPreviewPrevious?: () => void;
	onPreviewNext?: () => void;
}

export function CalendarToolbar({
	title,
	display,
	zoneTime,
	loading,
	onPrevious,
	onNext,
	onToday,
	onPreviewPrevious,
	onPreviewNext,
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
		<div className="flex items-start justify-between gap-4">
			<div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
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
	);
}
