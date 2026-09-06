import { Button, DatePicker, Dialog, Input, Select, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Globe, PencilSimple, X } from "@phosphor-icons/react";
import * as React from "react";

import {
	getPublishingTimeZone,
	publishingFieldsMatchInstant,
	publishingInstantToLocalFields,
	resolvePublishingLocalDateTime,
	serializeFuturePublishingDateTime,
	type PublishingDateTimeError,
} from "../lib/publishing-datetime.js";
import { getLocaleDir } from "../locales/config.js";
import { getDayPickerLocale } from "../locales/day-picker.js";
import { DialogError, getMutationError } from "./DialogError.js";

interface PublishingDateTimeFieldsProps {
	date: Date | undefined;
	time: string;
	disabled?: boolean;
	restrictToFuture?: boolean;
	dateAriaLabel: string;
	onDateChange: (date: Date | undefined) => void;
	onTimeChange: (time: string) => void;
}

function getLocalToday(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

type DayPeriod = "am" | "pm";

interface TimeParts {
	hour: string;
	minute: string;
	period: DayPeriod;
}

const TIME_VALUE_PATTERN = /^(?<hour>\d{2}):(?<minute>\d{2})$/;

function numericTimePart(value: string): string {
	return value
		.replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
		.replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
		.replace(/[\u0966-\u096f]/g, (digit) => String(digit.charCodeAt(0) - 0x0966))
		.replace(/[\u0e50-\u0e59]/g, (digit) => String(digit.charCodeAt(0) - 0x0e50))
		.replace(/\D/g, "")
		.slice(0, 2);
}

function uses12HourClock(locale: string): boolean {
	const hourCycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions()
		.hourCycle;
	return hourCycle === "h11" || hourCycle === "h12";
}

function dayPeriodLabel(locale: string, hour: number, fallback: string): string {
	return (
		new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true })
			.formatToParts(new Date(2020, 0, 1, hour))
			.find(({ type }) => type === "dayPeriod")?.value ?? fallback
	);
}

function timePartsFromValue(value: string, use12HourClock: boolean): TimeParts {
	const match = TIME_VALUE_PATTERN.exec(value);
	if (!match?.groups) return { hour: "", minute: "", period: "am" };
	const { hour = "", minute = "" } = match.groups;
	const hour24 = Number(hour);
	if (hour24 > 23 || Number(minute) > 59) {
		return { hour: "", minute: "", period: "am" };
	}
	return {
		hour: String(use12HourClock ? hour24 % 12 || 12 : hour24).padStart(2, "0"),
		minute,
		period: hour24 >= 12 ? "pm" : "am",
	};
}

function timeValueFromParts(parts: TimeParts, use12HourClock: boolean): string {
	if (parts.hour.length !== 2 || parts.minute.length !== 2) return "";
	const hour = Number(parts.hour);
	const minute = Number(parts.minute);
	if (minute > 59 || (use12HourClock ? hour < 1 || hour > 12 : hour > 23)) return "";
	const hour24 = use12HourClock ? (hour % 12) + (parts.period === "pm" ? 12 : 0) : hour;
	return `${String(hour24).padStart(2, "0")}:${parts.minute}`;
}

export function PublishingDateTimeFields({
	date,
	time,
	disabled,
	restrictToFuture,
	dateAriaLabel,
	onDateChange,
	onTimeChange,
}: PublishingDateTimeFieldsProps) {
	const { i18n, t } = useLingui();
	const today = getLocalToday();
	const [month, setMonth] = React.useState(date ?? today);
	React.useEffect(() => {
		setMonth(date ?? getLocalToday());
	}, [date]);
	const resolved = resolvePublishingLocalDateTime(date, time);
	const zoneDate = resolved.success ? resolved.date : (date ?? new Date());
	const { timeZone, shortName } = getPublishingTimeZone(zoneDate, i18n.locale);
	const zoneDetails = timeZone ? (shortName ? `${timeZone} (${shortName})` : timeZone) : null;
	const zoneValue = zoneDetails ?? t`Local time`;
	const use12HourClock = React.useMemo(() => uses12HourClock(i18n.locale), [i18n.locale]);
	const periodItems = React.useMemo(
		() => [
			{ value: "am" as const, label: dayPeriodLabel(i18n.locale, 9, "AM") },
			{ value: "pm" as const, label: dayPeriodLabel(i18n.locale, 13, "PM") },
		],
		[i18n.locale],
	);
	const [timeParts, setTimeParts] = React.useState(() => timePartsFromValue(time, use12HourClock));
	const minuteInputRef = React.useRef<HTMLInputElement>(null);
	const lastEmittedValueRef = React.useRef<string | null>(null);
	const previousHourCycleRef = React.useRef(use12HourClock);
	React.useEffect(() => {
		const hourCycleChanged = previousHourCycleRef.current !== use12HourClock;
		previousHourCycleRef.current = use12HourClock;
		if (!hourCycleChanged && lastEmittedValueRef.current === time) {
			lastEmittedValueRef.current = null;
			return;
		}
		lastEmittedValueRef.current = null;
		setTimeParts(timePartsFromValue(time, use12HourClock));
	}, [time, use12HourClock]);
	const updateTimeParts = (nextParts: TimeParts) => {
		setTimeParts(nextParts);
		const nextValue = timeValueFromParts(nextParts, use12HourClock);
		lastEmittedValueRef.current = nextValue;
		onTimeChange(nextValue);
	};
	const updateHour = (value: string) => {
		let hour = numericTimePart(value);
		if (hour.length === 1 && Number(hour) > (use12HourClock ? 1 : 2)) hour = `0${hour}`;
		if (
			hour.length === 2 &&
			(use12HourClock ? Number(hour) < 1 || Number(hour) > 12 : Number(hour) > 23)
		) {
			return;
		}
		updateTimeParts({ ...timeParts, hour });
		if (hour.length === 2) {
			minuteInputRef.current?.focus();
			minuteInputRef.current?.select();
		}
	};
	const updateMinute = (value: string) => {
		const minute = numericTimePart(value);
		if (minute.length === 2 && Number(minute) > 59) return;
		updateTimeParts({ ...timeParts, minute });
	};

	return (
		<div className="space-y-4">
			<DatePicker
				mode="single"
				selected={date}
				month={month}
				onMonthChange={setMonth}
				onChange={onDateChange}
				disabled={disabled ? true : restrictToFuture ? { before: today } : undefined}
				locale={getDayPickerLocale(i18n.locale)}
				dir={getLocaleDir(i18n.locale)}
				aria-label={dateAriaLabel}
				className="w-full"
				classNames={{
					caption_label: "rdp-caption_label text-base !font-medium",
					month: "rdp-month !w-full",
					month_grid: "rdp-month_grid !w-full table-fixed",
					months: "rdp-months !w-full !max-w-none",
				}}
			/>
			<fieldset>
				<Text as="legend" bold DANGEROUS_className="mb-2">
					{t`Time`}
				</Text>
				<div
					className={
						use12HourClock
							? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
							: "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
					}
				>
					<Input
						aria-label={t`Hour`}
						placeholder="--"
						value={timeParts.hour}
						type="text"
						inputMode="numeric"
						maxLength={2}
						pattern="[0-9]*"
						autoComplete="off"
						onChange={(event) => updateHour(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						onBlur={(event) => {
							const hour = numericTimePart(event.currentTarget.value);
							if (hour.length === 1) updateHour(hour.padStart(2, "0"));
						}}
						disabled={disabled}
						className="w-full tabular-nums"
					/>
					<Text as="span" variant="secondary" DANGEROUS_className="tabular-nums">
						:
					</Text>
					<Input
						ref={minuteInputRef}
						aria-label={t`Minute`}
						placeholder="--"
						value={timeParts.minute}
						type="text"
						inputMode="numeric"
						maxLength={2}
						pattern="[0-9]*"
						autoComplete="off"
						onChange={(event) => updateMinute(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						onBlur={(event) => {
							const minute = numericTimePart(event.currentTarget.value);
							if (minute.length === 1) updateMinute(minute.padStart(2, "0"));
						}}
						disabled={disabled}
						className="w-full tabular-nums"
					/>
					{use12HourClock ? (
						<Select
							aria-label={t`Period`}
							value={timeParts.period}
							onValueChange={(period) => {
								if (period === "am" || period === "pm") {
									updateTimeParts({ ...timeParts, period });
								}
							}}
							items={periodItems}
							disabled={disabled}
							className="w-full"
						/>
					) : null}
				</div>
			</fieldset>
			<div className="flex items-start gap-2 text-kumo-subtle">
				<span className="flex h-lh items-center" aria-hidden="true">
					<Globe className="size-4" />
				</span>
				<Text as="p" variant="secondary" DANGEROUS_className="min-w-0">
					<span className="sr-only">{t`Timezone`}: </span>
					<bdi>{zoneValue}</bdi>
				</Text>
			</div>
		</div>
	);
}

export interface PublishingScheduleDialogProps {
	open: boolean;
	entryKey: string;
	scheduledAt?: string | null;
	isLive: boolean;
	isPending?: boolean;
	onOpenChange: (open: boolean) => void;
	onSchedule?: (scheduledAt: string) => void | Promise<void>;
}

function validationMessage(error: PublishingDateTimeError, t: ReturnType<typeof useLingui>["t"]) {
	switch (error) {
		case "missing-date":
			return t`Choose a date`;
		case "missing-time":
			return t`Choose a time`;
		case "past":
			return t`Choose a time in the future`;
		case "nonexistent-time":
			return t`That time does not exist in your time zone`;
		case "invalid-date":
		case "invalid-time":
			return t`Choose a valid date and time`;
	}
}

interface PublishingDateTimeDialogContentProps {
	title: string;
	description?: string;
	date: Date | undefined;
	time: string;
	pending: boolean;
	restrictToFuture?: boolean;
	dateAriaLabel: string;
	errorMessage: string | null;
	submitLabel: string;
	submitDisabled: boolean;
	onDateChange: (date: Date | undefined) => void;
	onTimeChange: (time: string) => void;
	onSubmit: () => void;
}

function PublishingDateTimeDialogContent({
	title,
	description,
	date,
	time,
	pending,
	restrictToFuture,
	dateAriaLabel,
	errorMessage,
	submitLabel,
	submitDisabled,
	onDateChange,
	onTimeChange,
	onSubmit,
}: PublishingDateTimeDialogContentProps) {
	const { t } = useLingui();
	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		event.stopPropagation();
		onSubmit();
	};

	return (
		<Dialog
			className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto px-6 py-4 sm:px-7 sm:py-5"
			size="sm"
			style={{ width: "22rem" }}
		>
			<form onSubmit={handleSubmit} noValidate>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0 grid gap-1.5">
						<Dialog.Title className="text-lg font-semibold leading-6">{title}</Dialog.Title>
						{description ? (
							<Dialog.Description className="text-base leading-5 text-pretty text-kumo-subtle">
								{description}
							</Dialog.Description>
						) : null}
					</div>
					<Dialog.Close
						render={
							<Button
								type="button"
								variant="ghost"
								shape="square"
								icon={<X aria-hidden="true" />}
								aria-label={t`Close`}
							/>
						}
					/>
				</div>

				<div className="mt-4">
					<PublishingDateTimeFields
						date={date}
						time={time}
						disabled={pending}
						restrictToFuture={restrictToFuture}
						dateAriaLabel={dateAriaLabel}
						onDateChange={onDateChange}
						onTimeChange={onTimeChange}
					/>
				</div>
				<DialogError message={errorMessage} className="mt-3" />
				<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<Dialog.Close render={<Button type="button" variant="secondary" />}>
						{t`Cancel`}
					</Dialog.Close>
					<Button
						type="submit"
						variant="primary"
						loading={pending}
						onClick={(event) => {
							event.preventDefault();
							onSubmit();
						}}
						disabled={pending || submitDisabled}
					>
						{submitLabel}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

export function PublishingScheduleDialog({
	open,
	entryKey,
	scheduledAt = null,
	isLive,
	isPending,
	onOpenChange,
	onSchedule,
}: PublishingScheduleDialogProps) {
	const { t } = useLingui();
	const initial = React.useMemo(() => publishingInstantToLocalFields(scheduledAt), [scheduledAt]);
	const [date, setDate] = React.useState(initial.date);
	const [time, setTime] = React.useState(initial.time);
	const [validationError, setValidationError] = React.useState<string | null>(null);
	const [mutationError, setMutationError] = React.useState<unknown>(null);
	const [submitting, setSubmitting] = React.useState(false);
	const generationRef = React.useRef(0);
	const contextRef = React.useRef(entryKey);
	const activeSubmissionRef = React.useRef<{ entryKey: string; generation: number } | null>(null);
	contextRef.current = entryKey;
	const pending = Boolean(isPending || submitting);
	const isEditing = Boolean(scheduledAt);

	const reset = React.useCallback(() => {
		const next = publishingInstantToLocalFields(scheduledAt);
		setDate(next.date);
		setTime(next.time);
		setValidationError(null);
		setMutationError(null);
	}, [scheduledAt]);

	React.useEffect(() => {
		generationRef.current++;
		activeSubmissionRef.current = null;
		setSubmitting(false);
		reset();
	}, [entryKey, reset]);

	const clearError = () => {
		setValidationError(null);
		setMutationError(null);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen && !pending) reset();
		onOpenChange(nextOpen);
	};

	const submit = async () => {
		if (!onSchedule || pending || activeSubmissionRef.current?.entryKey === entryKey) return;
		const result = serializeFuturePublishingDateTime(date, time);
		if (!result.success) {
			setValidationError(validationMessage(result.error, t));
			return;
		}
		if (isEditing && publishingFieldsMatchInstant(scheduledAt, date, time)) return;

		clearError();
		const generation = ++generationRef.current;
		const submission = { entryKey, generation };
		activeSubmissionRef.current = submission;
		setSubmitting(true);
		try {
			await onSchedule(result.value);
			if (contextRef.current === entryKey && generationRef.current === generation) {
				reset();
				onOpenChange(false);
			}
		} catch (error) {
			if (contextRef.current === entryKey && generationRef.current === generation) {
				setMutationError(error);
			}
		} finally {
			if (activeSubmissionRef.current === submission) activeSubmissionRef.current = null;
			if (contextRef.current === entryKey && generationRef.current === generation) {
				setSubmitting(false);
			}
		}
	};
	const title = isEditing
		? t`Change schedule`
		: isLive
			? t`Schedule changes`
			: t`Schedule publication`;
	const description = isLive
		? t`Choose when these changes replace the live version.`
		: isEditing
			? t`Choose a new publication time for this draft.`
			: t`Choose when this draft becomes public.`;
	const submitLabel = isEditing ? t`Save schedule` : isLive ? t`Schedule changes` : t`Schedule`;

	return (
		<Dialog.Root open={open} onOpenChange={handleOpenChange}>
			<PublishingDateTimeDialogContent
				title={title}
				description={description}
				date={date}
				time={time}
				pending={pending}
				restrictToFuture
				dateAriaLabel={t`Schedule date`}
				errorMessage={validationError ?? getMutationError(mutationError)}
				submitLabel={submitLabel}
				submitDisabled={isEditing && publishingFieldsMatchInstant(scheduledAt, date, time)}
				onDateChange={(nextDate) => {
					setDate(nextDate);
					clearError();
				}}
				onTimeChange={(nextTime) => {
					setTime(nextTime);
					clearError();
				}}
				onSubmit={() => void submit()}
			/>
		</Dialog.Root>
	);
}

export interface PublicationDateDialogProps {
	entryKey: string;
	publishedAt: string;
	label: string;
	formattedValue: string;
	isPending?: boolean;
	onPublishedAtChange: (publishedAt: string) => void | Promise<void>;
}

export function PublicationDateDialog({
	entryKey,
	publishedAt,
	label,
	formattedValue,
	isPending,
	onPublishedAtChange,
}: PublicationDateDialogProps) {
	const { t } = useLingui();
	const initial = React.useMemo(() => publishingInstantToLocalFields(publishedAt), [publishedAt]);
	const [open, setOpen] = React.useState(false);
	const [date, setDate] = React.useState(initial.date);
	const [time, setTime] = React.useState(initial.time);
	const [validationError, setValidationError] = React.useState<string | null>(null);
	const [mutationError, setMutationError] = React.useState<unknown>(null);
	const [submitting, setSubmitting] = React.useState(false);
	const generationRef = React.useRef(0);
	const contextKey = `${entryKey}:${publishedAt}`;
	const contextRef = React.useRef(contextKey);
	const activeSubmissionRef = React.useRef<{ contextKey: string; generation: number } | null>(null);
	contextRef.current = contextKey;
	const pending = Boolean(isPending || submitting);

	const reset = React.useCallback(() => {
		const next = publishingInstantToLocalFields(publishedAt);
		setDate(next.date);
		setTime(next.time);
		setValidationError(null);
		setMutationError(null);
	}, [publishedAt]);

	React.useEffect(() => {
		generationRef.current++;
		activeSubmissionRef.current = null;
		setSubmitting(false);
		setOpen(false);
		reset();
	}, [contextKey, reset]);

	const clearError = () => {
		setValidationError(null);
		setMutationError(null);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen && !pending) reset();
		setOpen(nextOpen);
	};

	const submit = async () => {
		if (pending || activeSubmissionRef.current?.contextKey === contextKey) return;
		const result = resolvePublishingLocalDateTime(date, time);
		if (!result.success) {
			setValidationError(validationMessage(result.error, t));
			return;
		}
		if (publishingFieldsMatchInstant(publishedAt, date, time)) return;

		clearError();
		const generation = ++generationRef.current;
		const submission = { contextKey, generation };
		activeSubmissionRef.current = submission;
		setSubmitting(true);
		try {
			await onPublishedAtChange(result.value);
			if (contextRef.current === contextKey && generationRef.current === generation) {
				reset();
				setOpen(false);
			}
		} catch (error) {
			if (contextRef.current === contextKey && generationRef.current === generation) {
				setMutationError(error);
			}
		} finally {
			if (activeSubmissionRef.current === submission) activeSubmissionRef.current = null;
			if (contextRef.current === contextKey && generationRef.current === generation) {
				setSubmitting(false);
			}
		}
	};
	return (
		<Dialog.Root open={open} onOpenChange={handleOpenChange}>
			<Dialog.Trigger
				render={
					<Button
						type="button"
						variant="ghost"
						className="-mx-2 h-9 w-[calc(100%+1rem)] min-w-0 overflow-hidden whitespace-nowrap px-2 py-1.5 font-normal"
						aria-label={t`Change publication date: ${formattedValue}`}
					/>
				}
			>
				<span className="flex w-full min-w-0 items-center gap-2">
					<Text as="span" variant="secondary" truncate DANGEROUS_className="flex-1 text-start">
						{label}
					</Text>
					<span className="flex shrink-0 items-center justify-end gap-1.5 whitespace-nowrap text-end">
						<time dateTime={publishedAt}>{formattedValue}</time>
						<PencilSimple className="size-3 shrink-0" aria-hidden="true" />
					</span>
				</span>
			</Dialog.Trigger>
			<PublishingDateTimeDialogContent
				title={t`Change publication date`}
				date={date}
				time={time}
				pending={pending}
				dateAriaLabel={t`Publication date`}
				errorMessage={validationError ?? getMutationError(mutationError)}
				submitLabel={t`Save date`}
				submitDisabled={publishingFieldsMatchInstant(publishedAt, date, time)}
				onDateChange={(nextDate) => {
					setDate(nextDate);
					clearError();
				}}
				onTimeChange={(nextTime) => {
					setTime(nextTime);
					clearError();
				}}
				onSubmit={() => void submit()}
			/>
		</Dialog.Root>
	);
}
