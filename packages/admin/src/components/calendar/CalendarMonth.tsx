import {
	Badge,
	Button,
	DatePicker,
	Popover,
	SkeletonLine,
	TooltipProvider,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";
import type { DayButtonProps } from "react-day-picker";

import type { CalendarDisplay, CalendarItem, CalendarState } from "../../lib/calendar.js";
import { cn } from "../../lib/utils.js";
import { getDayPickerLocale } from "../../locales/day-picker.js";
import { getLocaleDir } from "../../locales/index.js";
import {
	CalendarDayList,
	CalendarEntryChip,
	CalendarNowLine,
	type CalendarSelectHandler,
} from "./CalendarEntry.js";

/** A cell shows every entry up to this many; past it, one fewer plus "+N more". */
const MAX_CHIPS = 4;
const MAX_DOTS = 3;

const DOT_COLORS: Record<CalendarState, string> = {
	published: "bg-kumo-success",
	scheduled: "bg-kumo-info",
	update: "bg-kumo-info",
	overdue: "bg-kumo-warning",
};

interface CalendarMonthProps {
	month: string;
	/** Every day the grid shows, whole weeks from the locale's first weekday. */
	gridDays: readonly string[];
	days: ReadonlyMap<string, CalendarItem[]>;
	today: string;
	now: number;
	display: CalendarDisplay;
	loading?: boolean;
	/** The last day with loaded entries, when the range has more entries than were loaded. */
	loadedThrough?: string;
	/** Phones get a date picker with the chosen day's entries below it. */
	compact?: boolean;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
	onMonthChange: (month: string) => void;
}

export function CalendarMonth(props: CalendarMonthProps) {
	return props.compact ? <CalendarMonthPicker {...props} /> : <CalendarMonthGrid {...props} />;
}

function nowIndex(items: readonly CalendarItem[], now: number): number {
	const index = items.findIndex((item) => item.time > now);
	return index === -1 ? items.length : index;
}

function CalendarMonthGrid({
	month,
	gridDays,
	days,
	today,
	now,
	display,
	loadedThrough,
	selectedKey,
	onSelect,
}: CalendarMonthProps) {
	const weeks = React.useMemo(
		() =>
			Array.from({ length: Math.ceil(gridDays.length / 7) }, (_, week) =>
				gridDays.slice(week * 7, week * 7 + 7),
			),
		[gridDays],
	);

	return (
		<TooltipProvider delay={400}>
			<div className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
				<table className="w-full table-fixed border-collapse">
					<thead>
						<tr>
							{weeks[0]?.map((day) => (
								<th
									key={day}
									scope="col"
									aria-label={display.weekday(day)}
									className="px-2 pt-2 pb-1.5 text-end text-xs font-normal text-kumo-subtle"
								>
									{display.weekdayShort(day)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{weeks.map((week) => (
							<tr key={week[0]}>
								{week.map((day) => (
									<CalendarMonthCell
										key={day}
										day={day}
										items={days.get(day) ?? []}
										inMonth={day.startsWith(month)}
										loaded={loadedThrough === undefined || day < loadedThrough}
										today={today}
										now={now}
										display={display}
										selectedKey={selectedKey}
										onSelect={onSelect}
									/>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</TooltipProvider>
	);
}

interface CalendarMonthCellProps {
	day: string;
	items: readonly CalendarItem[];
	inMonth: boolean;
	/** False from the day the entry cap cut the range off, which may be only partly loaded. */
	loaded: boolean;
	today: string;
	now: number;
	display: CalendarDisplay;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
}

function CalendarMonthCell({
	day,
	items,
	inMonth,
	loaded,
	today,
	now,
	display,
	selectedKey,
	onSelect,
}: CalendarMonthCellProps) {
	const { t } = useLingui();
	const isToday = day === today;
	const visible = items.length > MAX_CHIPS ? items.slice(0, MAX_CHIPS - 1) : items;
	const nowAt = isToday ? nowIndex(items, now) : undefined;
	// The line goes among the chips, or after "+N more" once every entry is past;
	// when the present falls among the folded entries, only the popover shows it.
	const lineAt =
		nowAt === undefined || nowAt <= visible.length
			? nowAt
			: nowAt === items.length
				? items.length
				: undefined;
	const nowLine = (
		<li key="now" aria-hidden="true" className="px-0.5">
			<CalendarNowLine />
		</li>
	);
	const label = day.endsWith("-01") ? display.monthDayShort(day) : display.dayNumber(day);

	return (
		<td
			aria-current={isToday ? "date" : undefined}
			className={cn(
				"border-s border-t border-kumo-line p-1 align-top first:border-s-0",
				(!inMonth || display.isWeekend(day)) && "bg-kumo-elevated",
			)}
		>
			<div className="flex min-h-28 min-w-0 flex-col gap-1">
				<div className="flex justify-end">
					{isToday ? (
						<Badge variant="red" className="h-6 min-w-6 justify-center px-1.5 tabular-nums">
							{label}
						</Badge>
					) : (
						<span
							className={cn(
								"inline-flex h-6 min-w-6 items-center justify-center px-1.5 text-xs tabular-nums",
								!inMonth
									? "text-kumo-inactive"
									: day < today
										? "text-kumo-subtle"
										: "text-kumo-default",
							)}
						>
							{label}
						</span>
					)}
				</div>
				{items.length > 0 && (
					<ul aria-label={display.fullDate(day)} className="@container grid min-w-0 gap-1">
						{visible.map((item, index) => (
							<React.Fragment key={item.key}>
								{index === lineAt && nowLine}
								<li className="grid min-w-0">
									<CalendarEntryChip
										item={item}
										display={display}
										now={now}
										selected={item.key === selectedKey}
										onSelect={onSelect}
									/>
								</li>
							</React.Fragment>
						))}
						{lineAt === visible.length && nowLine}
						{visible.length < items.length && (
							<li>
								<CalendarMorePopover
									day={day}
									items={items}
									display={display}
									now={now}
									nowAt={nowAt}
									selectedKey={selectedKey}
									onSelect={onSelect}
								/>
							</li>
						)}
						{visible.length < items.length && lineAt === items.length && nowLine}
					</ul>
				)}
				{items.length === 0 && !loaded && (
					<p className="px-1 text-xs text-kumo-inactive">{t`Not loaded`}</p>
				)}
			</div>
		</td>
	);
}

interface CalendarMorePopoverProps {
	day: string;
	items: readonly CalendarItem[];
	display: CalendarDisplay;
	now: number;
	nowAt?: number;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
}

function CalendarMorePopover({
	day,
	items,
	display,
	now,
	nowAt,
	selectedKey,
	onSelect,
}: CalendarMorePopoverProps) {
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const hidden = items.length - (MAX_CHIPS - 1);
	const date = display.fullDate(day);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				render={
					<Button
						ref={triggerRef}
						variant="ghost"
						size="xs"
						className="w-full justify-start px-1.5 text-kumo-subtle"
						aria-label={plural(hidden, {
							one: `# more entry on ${date}`,
							other: `# more entries on ${date}`,
						})}
					/>
				}
			>
				{plural(hidden, { one: "+# more", other: "+# more" })}
			</Popover.Trigger>
			<Popover.Content className="w-80 max-w-[calc(100vw-2rem)] p-2" align="start">
				<Popover.Title className="px-2 pt-1 pb-2 text-sm font-semibold">{date}</Popover.Title>
				<CalendarDayList
					items={items}
					display={display}
					now={now}
					label={date}
					nowAt={nowAt}
					selectedKey={selectedKey}
					onSelect={
						onSelect &&
						((item, element) => {
							setOpen(false);
							// The popover's entries unmount with it, so focus returns to "+N more".
							onSelect(item, triggerRef.current ?? element);
						})
					}
					className="max-h-80 overflow-y-auto"
				/>
			</Popover.Content>
		</Popover>
	);
}

/** Each day's entry states, read by the picker's day buttons. */
const DayStatesContext = React.createContext<ReadonlyMap<string, CalendarState[]>>(new Map());

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** The picker works in local dates; noon keeps a day key on its date across DST changes. */
function dayKeyToLocalDate(day: string): Date {
	const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
	return new Date(year, month - 1, date, 12);
}

function localDateToDayKey(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function CalendarDayButton({ day, modifiers, children, ...props }: DayButtonProps) {
	const { t } = useLingui();
	const ref = React.useRef<HTMLButtonElement>(null);
	const states = React.useContext(DayStatesContext).get(localDateToDayKey(day.date)) ?? [];

	React.useEffect(() => {
		if (modifiers.focused) ref.current?.focus();
	}, [modifiers.focused]);

	const dayLabel = props["aria-label"] ?? "";
	const entries = plural(states.length, { one: "# entry", other: "# entries" });

	return (
		<button
			ref={ref}
			{...props}
			aria-label={states.length > 0 ? t`${dayLabel}, ${entries}` : dayLabel || undefined}
		>
			<span className="flex flex-col items-center gap-0.5 leading-none">
				{children}
				<span aria-hidden="true" className="flex h-1.5 items-center gap-0.5">
					{states.slice(0, MAX_DOTS).map((state, index) => (
						<span key={index} className={cn("size-1.5 rounded-full", DOT_COLORS[state])} />
					))}
					{states.length > MAX_DOTS && (
						<span className="text-[10px] leading-none font-semibold text-kumo-subtle">+</span>
					)}
				</span>
			</span>
		</button>
	);
}

function CalendarMonthPicker({
	month,
	days,
	today,
	now,
	display,
	loading,
	loadedThrough,
	selectedKey,
	onSelect,
	onMonthChange,
}: CalendarMonthProps) {
	const { t, i18n } = useLingui();
	const headingId = React.useId();
	const [picked, setPicked] = React.useState<string>();
	const [pickedMonth, setPickedMonth] = React.useState(month);
	if (pickedMonth !== month) {
		setPickedMonth(month);
		setPicked(undefined);
	}

	const states = React.useMemo(
		() => new Map(Array.from(days, ([day, items]) => [day, items.map((item) => item.state)])),
		[days],
	);
	const firstWithEntries = [...days.keys()].filter((day) => day.startsWith(month)).toSorted()[0];
	const selected =
		picked ?? (today.startsWith(month) ? today : (firstWithEntries ?? `${month}-01`));
	const items = days.get(selected) ?? [];

	return (
		<div className="grid gap-4">
			<DayStatesContext.Provider value={states}>
				<DatePicker
					mode="single"
					required
					selected={dayKeyToLocalDate(selected)}
					onChange={(date) => setPicked(localDateToDayKey(date))}
					month={dayKeyToLocalDate(`${month}-01`)}
					onMonthChange={(date) => onMonthChange(localDateToDayKey(date).slice(0, 7))}
					today={dayKeyToLocalDate(today)}
					hideNavigation
					showOutsideDays={false}
					animate={false}
					locale={getDayPickerLocale(i18n.locale)}
					dir={getLocaleDir(i18n.locale)}
					components={{ DayButton: CalendarDayButton }}
					className="w-full rounded-lg border border-kumo-line p-2"
					classNames={{
						month_caption: "sr-only",
						month: "rdp-month !w-full",
						month_grid: "rdp-month_grid !w-full table-fixed",
						months: "rdp-months !w-full !max-w-none",
					}}
				/>
			</DayStatesContext.Provider>
			<section aria-labelledby={headingId} className="grid gap-1">
				<h3
					id={headingId}
					className="flex items-baseline gap-2 border-b border-kumo-line px-2 pb-2 text-base"
				>
					<span className="font-semibold text-kumo-default">{display.weekday(selected)}</span>
					<span className="text-kumo-subtle">{display.monthDay(selected)}</span>
					{selected === today && (
						<Badge variant="red" className="self-center">
							{t`Today`}
						</Badge>
					)}
				</h3>
				{loading ? (
					<div aria-hidden="true" className="grid gap-3 px-2 py-2">
						<SkeletonLine minWidth={40} maxWidth={70} />
						<SkeletonLine minWidth={30} maxWidth={60} />
					</div>
				) : items.length > 0 ? (
					<CalendarDayList
						items={items}
						display={display}
						now={now}
						label={display.fullDate(selected)}
						nowAt={selected === today ? nowIndex(items, now) : undefined}
						selectedKey={selectedKey}
						onSelect={onSelect}
					/>
				) : (
					<p className="px-2 py-3 text-sm text-kumo-subtle">
						{loadedThrough && selected >= loadedThrough
							? t`This day wasn't loaded. The range has more entries than the calendar can show.`
							: t`Nothing on this day.`}
					</p>
				)}
			</section>
		</div>
	);
}
