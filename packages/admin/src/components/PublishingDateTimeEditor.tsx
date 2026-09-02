import { Button, DatePicker, Dialog, Input, Label, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Globe, X } from "@phosphor-icons/react";
import * as React from "react";

import {
	getPublishingQuickChoices,
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
	showQuickChoices?: boolean;
	onDateChange: (date: Date | undefined) => void;
	onTimeChange: (time: string) => void;
}

export function PublishingDateTimeFields({
	date,
	time,
	disabled,
	showQuickChoices,
	onDateChange,
	onTimeChange,
}: PublishingDateTimeFieldsProps) {
	const { i18n, t } = useLingui();
	const quickChoices = getPublishingQuickChoices();
	const timeFormatter = React.useMemo(
		() => new Intl.DateTimeFormat(i18n.locale, { hour: "numeric", minute: "2-digit" }),
		[i18n.locale],
	);
	const weekdayFormatter = React.useMemo(
		() => new Intl.DateTimeFormat(i18n.locale, { weekday: "long" }),
		[i18n.locale],
	);
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const [month, setMonth] = React.useState(date ?? today);
	React.useEffect(() => {
		if (date) setMonth(date);
	}, [date]);
	const resolved = resolvePublishingLocalDateTime(date, time);
	const zoneDate = resolved.success ? resolved.date : (date ?? new Date());
	const { timeZone, shortName } = getPublishingTimeZone(zoneDate, i18n.locale);
	const zoneDetails = timeZone ? (shortName ? `${timeZone} (${shortName})` : timeZone) : null;
	const zoneLabel = zoneDetails ? t`Times use ${zoneDetails}` : t`Times use your local time zone`;
	const tomorrowResult = resolvePublishingLocalDateTime(
		quickChoices.tomorrow.date,
		quickChoices.tomorrow.time,
	);
	const tomorrowTime = timeFormatter.format(
		tomorrowResult.success ? tomorrowResult.date : new Date(),
	);
	const mondayResult = resolvePublishingLocalDateTime(
		quickChoices.nextMonday.date,
		quickChoices.nextMonday.time,
	);
	const mondayDate = mondayResult.success ? mondayResult.date : new Date();
	const nextMondayLabel = t`Next ${weekdayFormatter.format(mondayDate)} at ${timeFormatter.format(mondayDate)}`;

	return (
		<div className="space-y-4">
			{showQuickChoices && (
				<div className="grid gap-2 sm:grid-cols-2">
					<Button
						type="button"
						variant="secondary"
						className="h-auto min-h-9 w-full justify-start whitespace-normal py-2 text-start"
						disabled={disabled}
						onClick={() => {
							onDateChange(quickChoices.tomorrow.date);
							onTimeChange(quickChoices.tomorrow.time);
						}}
					>
						{t`Tomorrow at ${tomorrowTime}`}
					</Button>
					<Button
						type="button"
						variant="secondary"
						className="h-auto min-h-9 w-full justify-start whitespace-normal py-2 text-start"
						disabled={disabled}
						onClick={() => {
							onDateChange(quickChoices.nextMonday.date);
							onTimeChange(quickChoices.nextMonday.time);
						}}
					>
						{nextMondayLabel}
					</Button>
				</div>
			)}
			<div className="space-y-2">
				<Label>{t`Date`}</Label>
				<DatePicker
					mode="single"
					selected={date}
					month={month}
					onMonthChange={setMonth}
					onChange={onDateChange}
					disabled={disabled ? true : { before: today }}
					locale={getDayPickerLocale(i18n.locale)}
					dir={getLocaleDir(i18n.locale)}
					aria-label={t`Schedule date`}
					className="mx-auto"
				/>
			</div>
			<Input
				label={t`Time`}
				type="time"
				step={60}
				value={time}
				onChange={(event) => onTimeChange(event.target.value)}
				disabled={disabled}
			/>
			<div className="flex items-start gap-2 text-kumo-subtle">
				<span className="flex h-lh items-center" aria-hidden="true">
					<Globe className="size-4" />
				</span>
				<Text as="p" variant="secondary">
					{zoneLabel}
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
	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		event.stopPropagation();
		void submit();
	};

	const title = isEditing
		? t`Edit schedule`
		: isLive
			? t`Schedule updates`
			: t`Schedule publication`;
	const description = isLive
		? t`Your current version stays live until these changes publish.`
		: t`Choose when this version should go live.`;
	const submitLabel = isEditing ? t`Update schedule` : isLive ? t`Schedule updates` : t`Schedule`;

	return (
		<Dialog.Root open={open} onOpenChange={handleOpenChange}>
			<Dialog className="max-w-[calc(100vw-2rem)] p-4 sm:p-6" size="sm">
				<form onSubmit={handleSubmit} noValidate>
					<div className="flex items-start justify-between gap-4">
						<div className="grid gap-1.5">
							<Dialog.Title className="text-lg font-semibold leading-6">{title}</Dialog.Title>
							<Dialog.Description className="text-base leading-5 text-pretty text-kumo-subtle">
								{description}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button
									{...props}
									type="button"
									variant="ghost"
									shape="square"
									icon={<X aria-hidden="true" />}
									aria-label={t`Close`}
								/>
							)}
						/>
					</div>

					<div className="mt-5">
						<PublishingDateTimeFields
							date={date}
							time={time}
							disabled={pending}
							showQuickChoices={!isEditing}
							onDateChange={(nextDate) => {
								setDate(nextDate);
								clearError();
							}}
							onTimeChange={(nextTime) => {
								setTime(nextTime);
								clearError();
							}}
						/>
					</div>
					<DialogError
						message={validationError ?? getMutationError(mutationError)}
						className="mt-3"
					/>
					<div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Dialog.Close
							render={(props) => (
								<Button {...props} type="button" variant="secondary">
									{t`Cancel`}
								</Button>
							)}
						/>
						<Button
							type="submit"
							variant="primary"
							loading={pending}
							onClick={(event) => {
								event.preventDefault();
								void submit();
							}}
							disabled={
								pending || (isEditing && publishingFieldsMatchInstant(scheduledAt, date, time))
							}
						>
							{submitLabel}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
