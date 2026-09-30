import { Button, LinkButton, SkeletonLine, Toast } from "@cloudflare/kumo";
import { Dialog } from "@cloudflare/kumo/primitives";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowsClockwise,
	ArrowSquareOut,
	CalendarDots,
	CheckCircle,
	CircleDashed,
	CircleHalf,
	Clock,
	ClockCounterClockwise,
	Eye,
	PaperPlaneTilt,
	PencilSimple,
	Signature,
	Tag,
	Translate,
	WarningCircle,
	X,
	type Icon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import type { AdminManifest } from "../../lib/api/client.js";
import {
	fetchContent,
	fetchTranslations,
	getPreviewUrl,
	publishContent,
	scheduleContent,
	unscheduleContent,
} from "../../lib/api/content.js";
import type { CurrentUser } from "../../lib/api/current-user.js";
import {
	formatTimeAgo,
	type CalendarDisplay,
	type CalendarItem,
	type CalendarState,
} from "../../lib/calendar.js";
import { contentUrl } from "../../lib/url.js";
import { cn } from "../../lib/utils.js";
import { getLocaleLabel } from "../../locales/index.js";
import { getMutationError } from "../DialogError.js";
import { PublishingScheduleDialog } from "../PublishingDateTimeEditor.js";
import { RouterLinkButton } from "../RouterLinkButton.js";
import {
	CALENDAR_STATE_LABELS,
	CalendarCollectionDot,
	CalendarCollectionTag,
	CalendarStateIcon,
} from "./CalendarEntry.js";

// Role levels (matching @emdash-cms/auth)
const ROLE_AUTHOR = 30;
const ROLE_EDITOR = 40;

const STATE_TEXT: Record<CalendarState, string> = {
	published: "text-kumo-success",
	scheduled: "text-kumo-info",
	update: "text-kumo-info",
	overdue: "text-kumo-warning",
};

export interface CalendarEntryPanelProps {
	/** The open entry; undefined closes the panel. */
	item: CalendarItem | undefined;
	display: CalendarDisplay;
	now: number;
	/** Narrow layouts show the panel as a bottom sheet over the page. */
	compact: boolean;
	i18n: AdminManifest["i18n"];
	/** Each collection's public URL pattern, for View live. */
	urlPatterns: Readonly<Record<string, string | undefined>>;
	user: CurrentUser | undefined;
	/** The entry link to focus when the panel closes, if it is still on the page. */
	returnFocus?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
	/** Called after the entry gets a new schedule, with its new time. */
	onRescheduled: (item: CalendarItem, scheduledAt: string) => void;
}

/**
 * An entry's details and publishing actions beside the calendar. On wide
 * layouts the calendar stays usable behind it, so picking another entry
 * switches the panel; on phones it is a modal bottom sheet.
 */
export function CalendarEntryPanel(props: CalendarEntryPanelProps) {
	const { item, compact, returnFocus, onClose } = props;
	// The panel keeps its content while it slides out.
	const [shown, setShown] = React.useState(item);
	if (item && item !== shown) setShown(item);

	return (
		<Dialog.Root
			open={Boolean(item)}
			modal={compact}
			disablePointerDismissal={!compact}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog.Portal>
				{compact && (
					<Dialog.Backdrop className="fixed inset-0 bg-kumo-recessed opacity-80 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
				)}
				<Dialog.Popup
					finalFocus={() => (returnFocus?.current?.isConnected ? returnFocus.current : true)}
					className={cn(
						"fixed flex flex-col bg-kumo-base text-kumo-default shadow-xl outline-none transition-transform duration-200 ease-out motion-reduce:transition-none",
						compact
							? "inset-x-0 bottom-0 max-h-[85dvh] max-w-none! rounded-t-xl data-ending-style:translate-y-full data-starting-style:translate-y-full"
							: "end-0 top-0 h-full w-full max-w-md border-s border-kumo-line data-ending-style:ltr:translate-x-full data-ending-style:rtl:-translate-x-full data-starting-style:ltr:translate-x-full data-starting-style:rtl:-translate-x-full",
					)}
				>
					{shown && <CalendarEntryPanelContent key={shown.key} {...props} item={shown} />}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function CalendarEntryPanelContent({
	item,
	display,
	now,
	compact,
	i18n,
	urlPatterns,
	user,
	onClose,
	onRescheduled,
}: CalendarEntryPanelProps & { item: CalendarItem }) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [scheduleOpen, setScheduleOpen] = React.useState(false);
	const [previewing, setPreviewing] = React.useState(false);

	const locale = i18n ? item.locale : undefined;
	const details = useQuery({
		queryKey: ["content", item.collection, item.id, { locale }],
		queryFn: () => fetchContent(item.collection, item.id, { locale }),
		staleTime: 0,
	});
	const translations = useQuery({
		queryKey: ["translations", item.collection, item.id],
		queryFn: () => fetchTranslations(item.collection, item.id),
		enabled: display.showLocale,
	});

	const entry = details.data;
	const canPublish = Boolean(
		user &&
		entry &&
		(user.role >= ROLE_EDITOR || (user.role >= ROLE_AUTHOR && entry.authorId === user.id)),
	);
	const scheduled = item.kind === "scheduled";
	const title = item.title;
	const collection = display.collection(item.collection);
	const editorLink = {
		to: "/content/$collection/$id",
		params: { collection: item.collection, id: item.id },
		search: { locale: item.locale },
	} as const;

	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ["calendar"] });
		void queryClient.invalidateQueries({ queryKey: ["content", item.collection] });
		void queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
	};
	const reportError = (errorTitle: string, error: unknown) => {
		toastManager.add({ title: errorTitle, description: getMutationError(error), type: "error" });
	};

	const publish = useMutation({
		mutationFn: () =>
			publishContent(item.collection, item.id, { locale: item.locale, _rev: entry?._rev }),
		onSuccess: () => {
			refresh();
			toastManager.add({ title: t`Published`, description: t`${title} is now live.` });
			onClose();
		},
		onError: (error) => reportError(t`Could not publish`, error),
	});
	const unschedule = useMutation({
		mutationFn: () => unscheduleContent(item.collection, item.id, { locale: item.locale }),
		onSuccess: () => {
			refresh();
			toastManager.add({
				title: t`Schedule removed`,
				description:
					item.status === "published"
						? t`The scheduled changes to ${title} stay as a draft.`
						: t`${title} is a draft again.`,
			});
			onClose();
		},
		onError: (error) => reportError(t`Could not remove the schedule`, error),
	});
	const reschedule = useMutation({
		mutationFn: (scheduledAt: string) =>
			scheduleContent(item.collection, item.id, scheduledAt, { locale: item.locale }),
		onSuccess: (_changed, scheduledAt) => {
			refresh();
			const when = display.formatDateTime(Date.parse(scheduledAt));
			toastManager.add({ title: t`Rescheduled`, description: t`${title} now goes live ${when}.` });
			onRescheduled(item, scheduledAt);
		},
	});

	const openPreview = async () => {
		setPreviewing(true);
		try {
			const result = await getPreviewUrl(item.collection, item.id);
			const fallback = contentUrl(
				item.collection,
				entry?.slug || item.id,
				urlPatterns[item.collection],
				{
					locale: item.locale,
					i18n,
					id: item.id,
					date: entry?.publishedAt,
				},
			);
			window.open(result?.url ?? fallback, "_blank", "noopener,noreferrer");
		} finally {
			setPreviewing(false);
		}
	};
	const liveUrl =
		item.state === "published" && entry?.slug
			? contentUrl(item.collection, entry.slug, urlPatterns[item.collection], {
					locale: item.locale,
					i18n,
					id: item.id,
					date: entry.publishedAt,
				})
			: undefined;

	const others = (translations.data?.translations ?? []).filter(
		(translation) => translation.locale !== item.locale,
	);
	const bylines = new Intl.ListFormat(display.locale, { type: "conjunction" }).format(
		(entry?.bylines ?? [])
			.toSorted((a, b) => a.sortOrder - b.sortOrder)
			.map((credit) => credit.byline.displayName),
	);
	const time = display.formatDateTime(item.time);
	const viewerTime = display.formatViewerTime(item.time);
	const lateness = formatTimeAgo(now - item.time, display.locale);
	const updatedAt = entry ? Date.parse(entry.updatedAt) : Number.NaN;
	const edited = Number.isNaN(updatedAt)
		? undefined
		: formatTimeAgo(now - updatedAt, display.locale);
	const livePublishedAt = entry?.publishedAt ? Date.parse(entry.publishedAt) : Number.NaN;
	const liveSince = Number.isNaN(livePublishedAt)
		? undefined
		: display.formatDateTime(livePublishedAt);

	return (
		<>
			{compact && (
				<span
					aria-hidden="true"
					className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-kumo-fill"
				/>
			)}
			<div className="flex shrink-0 items-center gap-1 px-3 py-2">
				<Dialog.Close
					render={
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							aria-label={t`Close`}
							icon={<X aria-hidden="true" />}
						/>
					}
				/>
				<p className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-sm text-kumo-subtle">
					<CalendarCollectionDot color={collection.color} />
					<span className="truncate">{collection.label}</span>
				</p>
				<RouterLinkButton
					{...editorLink}
					variant="ghost"
					shape="square"
					size="sm"
					aria-label={t`Open in editor`}
					icon={<ArrowSquareOut aria-hidden="true" className="rtl:-scale-x-100" />}
				/>
			</div>

			<div className="flex-1 overflow-y-auto px-5 pt-2 pb-6 sm:px-6">
				<Dialog.Title
					dir="auto"
					className="text-2xl leading-tight font-semibold tracking-tight break-words"
				>
					{title}
				</Dialog.Title>

				<dl className="mt-5 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
					<PanelProperty icon={CircleHalf} label={t`State`}>
						<span
							className={cn("inline-flex items-center gap-1.5 font-medium", STATE_TEXT[item.state])}
						>
							<CalendarStateIcon state={item.state} />
							{t(CALENDAR_STATE_LABELS[item.state])}
						</span>
					</PanelProperty>
					<PanelProperty
						icon={Clock}
						label={
							scheduled
								? item.state === "overdue"
									? t`Was due`
									: t`Goes live`
								: t(CALENDAR_STATE_LABELS.published)
						}
					>
						<span className="tabular-nums">{time}</span>
						{display.viewerZoneDiffers && (
							<span className="block text-xs text-kumo-subtle tabular-nums">
								{t`Your time: ${viewerTime}`}
							</span>
						)}
					</PanelProperty>
					<PanelProperty icon={Tag} label={t`Collection`}>
						<CalendarCollectionTag slug={item.collection} display={display} />
					</PanelProperty>
					{display.showLocale && (
						<PanelProperty icon={Translate} label={t`Locale`}>
							<span className="inline-flex items-center gap-1.5">
								{getLocaleLabel(item.locale)}
								<LocaleCode locale={item.locale} />
							</span>
							{others.length > 0 && (
								<span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-kumo-subtle">
									{t`Translations:`}
									{others.map((translation) => (
										<span key={translation.id}>
											<LocaleCode locale={translation.locale} />
											<span className="sr-only">{getLocaleLabel(translation.locale)}</span>
										</span>
									))}
								</span>
							)}
						</PanelProperty>
					)}
					{bylines && (
						<PanelProperty icon={Signature} label={t`Bylines`}>
							{bylines}
						</PanelProperty>
					)}
					<PanelProperty icon={ClockCounterClockwise} label={t`Last edited`}>
						{details.isPending ? <SkeletonLine minWidth={30} maxWidth={45} /> : (edited ?? "—")}
					</PanelProperty>
				</dl>

				{details.isError && (
					<p className="mt-4 text-sm text-kumo-danger">{t`Could not load this entry's details.`}</p>
				)}

				<hr className="my-6 border-kumo-line" />
				<h3 className="mb-4 text-sm font-semibold">{t`Publishing`}</h3>
				{item.state === "published" && (
					<PanelNote icon={CheckCircle} tone="neutral">
						{t`Published ${time}.`}
					</PanelNote>
				)}
				{item.state === "overdue" && (
					<PanelNote icon={WarningCircle} tone="warning">
						{t`This entry was due ${lateness} but hasn't published. Scheduled publishing may not be running.`}
					</PanelNote>
				)}
				{item.state === "scheduled" && (
					<PanelTimeline
						steps={[
							{
								icon: CircleDashed,
								tone: "neutral",
								title: t`Draft`,
								detail: edited && t`Last edited ${edited}`,
							},
							{
								icon: CalendarDots,
								tone: "info",
								title: t`Scheduled`,
								detail: t`Publishes ${time}`,
							},
						]}
					/>
				)}
				{item.state === "update" && (
					<PanelTimeline
						steps={[
							{
								icon: CheckCircle,
								tone: "success",
								title: t`Live version`,
								detail: liveSince && t`Published ${liveSince}`,
							},
							{
								icon: ArrowsClockwise,
								tone: "info",
								title: t`Scheduled changes`,
								detail: t`Go live ${time}`,
							},
						]}
					/>
				)}
			</div>

			<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-kumo-line px-5 py-3 sm:px-6">
				{item.state === "overdue" && canPublish && (
					<Button
						variant="primary"
						icon={<PaperPlaneTilt aria-hidden="true" className="rtl:-scale-x-100" />}
						loading={publish.isPending}
						disabled={unschedule.isPending}
						onClick={() => publish.mutate()}
					>
						{t`Publish now`}
					</Button>
				)}
				<RouterLinkButton
					{...editorLink}
					variant="secondary"
					icon={<PencilSimple aria-hidden="true" />}
				>
					{t`Open in editor`}
				</RouterLinkButton>
				{scheduled && canPublish && (
					<Button
						variant="secondary"
						icon={<CalendarDots aria-hidden="true" />}
						disabled={publish.isPending || unschedule.isPending}
						onClick={() => setScheduleOpen(true)}
					>
						{t`Reschedule`}
					</Button>
				)}
				{scheduled && (
					<Button
						variant="secondary"
						icon={<Eye aria-hidden="true" />}
						loading={previewing}
						onClick={() => void openPreview()}
					>
						{item.state === "update" ? t`Preview changes` : t`Preview`}
					</Button>
				)}
				{liveUrl && (
					<LinkButton
						href={liveUrl}
						external
						variant="secondary"
						icon={<ArrowSquareOut aria-hidden="true" className="rtl:-scale-x-100" />}
					>
						{t`View live`}
					</LinkButton>
				)}
				{scheduled && canPublish && (
					<Button
						variant="secondary-destructive"
						className="ms-auto"
						loading={unschedule.isPending}
						disabled={publish.isPending}
						onClick={() => unschedule.mutate()}
					>
						{t`Remove schedule`}
					</Button>
				)}
			</div>

			{scheduled && canPublish && (
				<PublishingScheduleDialog
					open={scheduleOpen}
					entryKey={item.key}
					scheduledAt={item.at}
					isLive={item.status === "published"}
					isPending={reschedule.isPending}
					onOpenChange={setScheduleOpen}
					onSchedule={async (scheduledAt) => {
						await reschedule.mutateAsync(scheduledAt);
					}}
				/>
			)}
		</>
	);
}

function PanelProperty({
	icon: PropertyIcon,
	label,
	children,
}: {
	icon: Icon;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<>
			<dt className="flex items-start gap-2 text-kumo-subtle">
				<PropertyIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0">{label}</span>
			</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</>
	);
}

function LocaleCode({ locale }: { locale: string }) {
	return (
		<span
			aria-hidden="true"
			className="rounded-sm bg-kumo-fill px-1 text-[10px] leading-4 font-semibold tracking-wide text-kumo-subtle uppercase"
		>
			{locale}
		</span>
	);
}

type PanelTone = "neutral" | "info" | "success" | "warning";

const TONE_TINTS: Record<PanelTone, string> = {
	neutral: "bg-kumo-fill text-kumo-subtle",
	info: "bg-kumo-info-tint text-kumo-info",
	success: "bg-kumo-success-tint text-kumo-success",
	warning: "bg-kumo-warning-tint text-kumo-warning",
};

function PanelNote({
	icon: NoteIcon,
	tone,
	children,
}: {
	icon: Icon;
	tone: "neutral" | "warning";
	children: React.ReactNode;
}) {
	return (
		<p
			className={cn(
				"flex gap-2.5 rounded-md px-3 py-2.5 text-sm leading-5",
				tone === "warning"
					? "bg-kumo-warning-tint text-kumo-default"
					: "bg-kumo-tint text-kumo-subtle",
			)}
		>
			<NoteIcon
				aria-hidden="true"
				className={cn("mt-0.5 size-4 shrink-0", tone === "warning" && "text-kumo-warning")}
			/>
			<span>{children}</span>
		</p>
	);
}

function PanelTimeline({
	steps,
}: {
	steps: ReadonlyArray<{ icon: Icon; tone: PanelTone; title: string; detail?: string | false }>;
}) {
	return (
		<ol className="grid">
			{steps.map((step, index) => {
				const StepIcon = step.icon;
				return (
					<li
						key={step.title}
						className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0"
					>
						{index < steps.length - 1 && (
							<span
								aria-hidden="true"
								className="absolute start-3 top-7 bottom-1 w-px -translate-x-1/2 bg-kumo-line rtl:translate-x-1/2"
							/>
						)}
						<span
							aria-hidden="true"
							className={cn("grid size-6 place-items-center rounded-full", TONE_TINTS[step.tone])}
						>
							<StepIcon className="size-3.5" />
						</span>
						<span className="grid gap-0.5 text-sm">
							<span className="leading-6 font-medium">{step.title}</span>
							{step.detail && <span className="text-kumo-subtle">{step.detail}</span>}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
