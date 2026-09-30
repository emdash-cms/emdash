import { Button, Loader } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Globe } from "@phosphor-icons/react";

import { CALENDAR_STATES, type CalendarDisplay, type CalendarState } from "../../lib/calendar.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";
import { CalendarStateIcon } from "./CalendarEntry.js";

interface CalendarToolbarProps {
	title: string;
	display: CalendarDisplay;
	/** An instant in the shown month, for zone names that change with daylight saving time. */
	zoneTime: number;
	loading: boolean;
	/** Entries per state in the month, shown as a legend; omitted until the whole month has loaded. */
	counts?: Record<CalendarState, number>;
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
	counts,
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
		<div className="grid gap-2">
			<div className="flex items-center justify-between gap-4">
				<div className="flex min-w-0 items-center gap-3">
					<h2 className="truncate text-xl leading-7 font-semibold text-kumo-default">{title}</h2>
					{loading && <Loader size="sm" aria-label={t`Loading`} />}
				</div>
				<div className="flex shrink-0 items-center gap-1">
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
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<p
					title={zoneDescription}
					className="flex items-center gap-1.5 text-sm text-kumo-subtle tabular-nums"
				>
					<Globe aria-hidden="true" className="size-4 shrink-0" />
					<span aria-hidden="true">
						{showViewerZone ? t`${siteZone} · Your time: ${viewerZone}` : siteZone}
					</span>
					<span className="sr-only">{zoneDescription}</span>
				</p>
				{counts && <CalendarLegend counts={counts} />}
			</div>
		</div>
	);
}

/** Each state's icon with its count, so the icons explain themselves. */
function CalendarLegend({ counts }: { counts: Record<CalendarState, number> }) {
	const { t } = useLingui();
	const labels: Record<CalendarState, string> = {
		published: plural(counts.published, { one: "# published", other: "# published" }),
		scheduled: plural(counts.scheduled, { one: "# scheduled", other: "# scheduled" }),
		update: plural(counts.update, { one: "# update scheduled", other: "# updates scheduled" }),
		overdue: plural(counts.overdue, { one: "# overdue", other: "# overdue" }),
	};
	const states = CALENDAR_STATES.filter((state) => counts[state] > 0);
	if (states.length === 0) return null;

	return (
		<ul
			aria-label={t`Entries this month`}
			className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-kumo-subtle"
		>
			{states.map((state) => (
				<li key={state} className="flex items-center gap-1.5 tabular-nums">
					<CalendarStateIcon state={state} />
					{labels[state]}
				</li>
			))}
		</ul>
	);
}
