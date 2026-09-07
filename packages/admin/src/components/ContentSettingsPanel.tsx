import {
	Badge,
	Button,
	Collapsible,
	Dialog,
	DropdownMenu,
	Input,
	Label,
	LayerCard,
	LinkButton,
	Loader,
	Select,
	Text,
	Tooltip,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowSquareOut,
	CalendarDots,
	CalendarPlus,
	CalendarX,
	CaretDown,
	Eye,
	EyeSlash,
	Info,
	Trash,
	Upload,
	X,
	type Icon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import type {
	AdminManifest,
	BylineCreditInput,
	BylineSummary,
	ContentItem,
	ContentSeoInput,
	TranslationSummary,
	UserListItem,
} from "../lib/api";
import {
	ContentEditorPanelBoundary,
	resolveContentEditorPanels,
} from "../lib/content-editor-panels";
import {
	getContentPublishingState,
	type ContentPublishingState,
} from "../lib/content-publishing-state.js";
import { usePluginAdmins } from "../lib/plugin-context";
import {
	formatPublishingInstant,
	formatPublishingInstantWithZone,
} from "../lib/publishing-datetime.js";
import { cn } from "../lib/utils";
import { BylineCreditsEditor } from "./BylineCreditsEditor.js";
import type { CurrentUserInfo } from "./ContentEditor.js";
import { ContentStatusIcon } from "./ContentStatusBadge.js";
import { DocumentOutline } from "./editor/DocumentOutline";
import { GalleryDetailPanel } from "./editor/GalleryDetailPanel";
import type { GalleryAttributes } from "./editor/GalleryNode";
import { ImageDetailPanel } from "./editor/ImageDetailPanel";
import type { ImageAttributes } from "./editor/ImageDetailPanel";
import type { BlockSidebarPanel } from "./PortableTextEditor";
import { PublicationDateDialog } from "./PublishingDateTimeEditor.js";
import { RevisionHistory } from "./RevisionHistory";
import { SaveButton } from "./SaveButton";
import { SeoPanel } from "./SeoPanel";
import {
	SortableContentSettingsSection,
	SortableContentSettingsSections,
} from "./SortableContentSettingsSections.js";
import { TaxonomySidebar, useHasApplicableTaxonomies } from "./TaxonomySidebar";
import { TranslationsPanel } from "./TranslationsPanel.js";

// Editor role level (40) from @emdash-cms/auth
const ROLE_EDITOR = 40;

function PublishingVersionRow({
	iconState,
	title,
	description,
	action,
	connectToNext,
}: {
	iconState: "published" | "draft" | "scheduled" | "pendingChanges";
	title: string;
	description: React.ReactNode;
	action?: React.ReactNode;
	connectToNext?: boolean;
}) {
	return (
		<div className="flex items-start gap-3">
			<span className="relative flex w-3.5 shrink-0 self-stretch justify-center">
				{connectToNext ? (
					<span className="absolute top-6 -bottom-3 w-px bg-kumo-line" aria-hidden="true" />
				) : null}
				<span className="relative z-10 flex h-5 items-center bg-kumo-base">
					<ContentStatusIcon state={iconState} decorative />
				</span>
			</span>
			<div className="min-w-0 flex-1">
				<Text as="p" bold>
					{title}
				</Text>
				<Text as="p" variant="secondary" DANGEROUS_className="mt-0.5 text-pretty">
					{description}
				</Text>
				{action ? <div className="-ms-2 mt-1">{action}</div> : null}
			</div>
		</div>
	);
}

function PublishingVersionRelationship({
	publishingState,
	supportsDrafts,
	scheduledAt,
	locale,
	onDiscardDraft,
}: {
	publishingState: ContentPublishingState;
	supportsDrafts: boolean;
	scheduledAt?: string | null;
	locale: string;
	onDiscardDraft?: () => void;
}) {
	const { t } = useLingui();
	const formattedSchedule = scheduledAt
		? formatPublishingInstantWithZone(scheduledAt, locale)
		: null;
	const scheduledSummary =
		scheduledAt && formattedSchedule ? (
			<time dateTime={scheduledAt}>{t`Scheduled for ${formattedSchedule}`}</time>
		) : null;

	if (!supportsDrafts) {
		return scheduledSummary ? (
			<div className="grid gap-4 px-3 py-3">
				<PublishingVersionRow
					iconState="scheduled"
					title={t`Scheduled publication`}
					description={scheduledSummary}
				/>
			</div>
		) : null;
	}

	let rows: React.ReactNode;
	switch (publishingState) {
		case "draft":
			rows = (
				<PublishingVersionRow
					iconState="draft"
					title={t`Draft version`}
					description={t`This version is not visible on the site`}
				/>
			);
			break;
		case "scheduled":
			rows = (
				<PublishingVersionRow
					iconState="scheduled"
					title={t`First publication`}
					description={scheduledSummary ?? t`A publication time has not been selected`}
				/>
			);
			break;
		case "published":
			rows = (
				<PublishingVersionRow
					iconState="published"
					title={t`Live version`}
					description={t`Visitors see this published version`}
				/>
			);
			break;
		case "published-with-changes":
			rows = (
				<>
					<PublishingVersionRow
						iconState="published"
						title={t`Live version`}
						description={t`Visitors still see the published version`}
						connectToNext
					/>
					<PublishingVersionRow
						iconState="pendingChanges"
						title={t`Draft changes`}
						description={t`Ready to publish now or schedule for later`}
						action={
							onDiscardDraft ? (
								<DiscardDraftDialog onDiscard={onDiscardDraft} triggerSize="sm" />
							) : undefined
						}
					/>
				</>
			);
			break;
		case "update-scheduled":
			rows = (
				<>
					<PublishingVersionRow
						iconState="published"
						title={t`Live version`}
						description={t`Visitors see the published version until the scheduled update`}
						connectToNext
					/>
					<PublishingVersionRow
						iconState="scheduled"
						title={t`Draft changes`}
						description={scheduledSummary ?? t`A publication time has not been selected`}
						action={
							onDiscardDraft ? (
								<DiscardDraftDialog onDiscard={onDiscardDraft} triggerSize="sm" />
							) : undefined
						}
					/>
				</>
			);
			break;
		case "published-scheduled":
			rows = (
				<>
					<PublishingVersionRow
						iconState="published"
						title={t`Live version`}
						description={t`Visitors see this published version`}
						connectToNext
					/>
					<PublishingVersionRow
						iconState="scheduled"
						title={t`Scheduled publication`}
						description={scheduledSummary ?? t`A publication time has not been selected`}
					/>
				</>
			);
	}

	return <div className="grid gap-4 px-3 py-3">{rows}</div>;
}

function TimestampValue({
	value,
	locale,
	size = "base",
}: {
	value: string;
	locale: string;
	size?: "sm" | "base";
}) {
	return (
		<time dateTime={value}>
			<Text as="span" size={size}>
				{formatPublishingInstant(value, locale)}
			</Text>
		</time>
	);
}

function TimestampRow({
	label,
	children,
	size = "base",
}: React.PropsWithChildren<{ label: string; size?: "sm" | "base" }>) {
	return (
		<div className="flex items-center justify-between gap-2 whitespace-nowrap">
			<dt className="min-w-0 flex-1">
				<Text as="span" variant="secondary" size={size} truncate>
					{label}
				</Text>
			</dt>
			<dd className="shrink-0 text-end">{children}</dd>
		</div>
	);
}

/**
 * Discard-draft confirmation shared by the settings action bar and the
 * distraction-free overlay, so the copy and behavior can't drift.
 */
export function DiscardDraftDialog({
	onDiscard,
	triggerVariant = "ghost",
	triggerSize,
}: {
	onDiscard?: () => void;
	triggerVariant?: "ghost" | "outline";
	triggerSize?: "sm";
}) {
	const { t } = useLingui();
	return (
		<Dialog.Root>
			<Dialog.Trigger
				render={(p) => (
					<Button {...p} type="button" variant={triggerVariant} size={triggerSize} icon={<X />}>
						{t`Discard changes`}
					</Button>
				)}
			/>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">{t`Discard draft changes?`}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle">
					{t`This will revert to the published version. Your draft changes will be lost.`}
				</Dialog.Description>
				<div className="mt-6 flex justify-end gap-2">
					<Dialog.Close
						render={(p) => (
							<Button {...p} variant="secondary">
								{t`Cancel`}
							</Button>
						)}
					/>
					<Dialog.Close
						render={(p) => (
							<Button {...p} variant="destructive" onClick={onDiscard}>
								{t`Discard changes`}
							</Button>
						)}
					/>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

export interface SettingsActionBarProps {
	collectionLabel?: string;
	isNew?: boolean;
	isDirty: boolean;
	isSaving: boolean;
	/** Autosave in flight — reported by the save button's busy state. */
	isAutosaving?: boolean;
	/** Preserve operation blocking independently of the visual feedback state. */
	saveDisabled?: boolean;
	isLive: boolean;
	hasPendingChanges: boolean;
	publishingState?: ContentPublishingState;
	canSchedule?: boolean;
	isScheduling?: boolean;
	isUnscheduling?: boolean;
	liveViewUrl?: string | null;
	supportsPreview?: boolean;
	isLoadingPreview?: boolean;
	onPreview?: () => void;
	onPublish?: () => void;
	onUnpublish?: () => void;
	onOpenSchedule?: () => void;
	onUnschedule?: () => void | Promise<void>;
	onMenuOpenChange?: (open: boolean) => void;
	announceSaveStatus?: boolean;
}

function SettingsActionSlot({ children }: React.PropsWithChildren) {
	return (
		<div className="flex min-w-max flex-[1_1_auto] [&>*]:w-full [&>*]:justify-center">
			{children}
		</div>
	);
}

export interface PreviewButtonProps {
	hasPendingChanges: boolean;
	isLoadingPreview?: boolean;
	onPreview?: () => void;
	size?: "sm";
}

export function PreviewButton({
	hasPendingChanges,
	isLoadingPreview,
	onPreview,
	size,
}: PreviewButtonProps) {
	const { t } = useLingui();
	return (
		<Button
			type="button"
			variant="outline"
			size={size}
			onClick={onPreview}
			disabled={isLoadingPreview}
			icon={isLoadingPreview ? <Loader size="sm" /> : <Eye />}
		>
			{hasPendingChanges ? t`Preview draft` : t`Preview`}
		</Button>
	);
}

export interface PublishActionsProps {
	collectionLabel?: string;
	isNew?: boolean;
	isLive: boolean;
	hasPendingChanges: boolean;
	publishingState?: ContentPublishingState;
	canSchedule?: boolean;
	isScheduling?: boolean;
	isUnscheduling?: boolean;
	onPublish?: () => void;
	onUnpublish?: () => void;
	onOpenSchedule?: () => void;
	onUnschedule?: () => void | Promise<void>;
	onMenuOpenChange?: (open: boolean) => void;
	size?: "sm";
	fullWidth?: boolean;
}

interface PublishingAction {
	kind: "publish" | "schedule" | "unschedule";
	label: string;
	Icon: Icon;
	onSelect: () => void;
}

export function PublishActions({
	collectionLabel,
	isNew,
	isLive,
	hasPendingChanges,
	publishingState,
	canSchedule,
	isScheduling,
	isUnscheduling,
	onPublish,
	onUnpublish,
	onOpenSchedule,
	onUnschedule,
	onMenuOpenChange,
	size,
	fullWidth,
}: PublishActionsProps) {
	const { t } = useLingui();
	const itemLabel = collectionLabel ?? t`content`;
	const [open, setOpen] = React.useState(false);
	const openRef = React.useRef(open);
	openRef.current = open;
	React.useEffect(
		() => () => {
			if (openRef.current) onMenuOpenChange?.(false);
		},
		[onMenuOpenChange],
	);
	const state =
		publishingState ??
		(isLive ? (hasPendingChanges ? "published-with-changes" : "published") : "draft");
	const hasDraftChanges = state === "published-with-changes" || state === "update-scheduled";
	const closeMenu = () => {
		setOpen(false);
		onMenuOpenChange?.(false);
	};
	const openSchedule = () => {
		closeMenu();
		onOpenSchedule?.();
	};
	const removeSchedule = () => {
		closeMenu();
		void Promise.resolve(onUnschedule?.()).catch(() => undefined);
	};
	const publish = () => {
		closeMenu();
		onPublish?.();
	};

	if (isNew) return null;
	if (state === "published") {
		return onUnpublish ? (
			<Button type="button" variant="outline" size={size} onClick={onUnpublish} icon={<EyeSlash />}>
				{t`Unpublish ${itemLabel}`}
			</Button>
		) : null;
	}

	const actions: PublishingAction[] = [];
	if (onPublish) {
		actions.push({
			kind: "publish",
			label: hasDraftChanges ? t`Publish changes now` : t`Publish now`,
			Icon: Upload,
			onSelect: publish,
		});
	}
	if (state === "draft" && canSchedule && onOpenSchedule) {
		actions.push({
			kind: "schedule",
			label: t`Schedule publication`,
			Icon: CalendarPlus,
			onSelect: openSchedule,
		});
	}
	if (state === "published-with-changes" && canSchedule && onOpenSchedule) {
		actions.push({
			kind: "schedule",
			label: t`Schedule changes`,
			Icon: CalendarPlus,
			onSelect: openSchedule,
		});
	}
	if (
		(state === "scheduled" || state === "update-scheduled" || state === "published-scheduled") &&
		onOpenSchedule
	) {
		actions.push({
			kind: "schedule",
			label: t`Change schedule`,
			Icon: CalendarDots,
			onSelect: openSchedule,
		});
	}
	if (
		(state === "scheduled" || state === "update-scheduled" || state === "published-scheduled") &&
		onUnschedule
	) {
		actions.push({
			kind: "unschedule",
			label: t`Remove schedule`,
			Icon: CalendarX,
			onSelect: removeSchedule,
		});
	}

	if (actions.length === 0) return null;
	if (actions.length === 1) {
		const action = actions[0]!;
		const label = state === "draft" && action.kind === "publish" ? t`Publish` : action.label;
		return (
			<Button
				type="button"
				variant="primary"
				size={size}
				onClick={action.onSelect}
				icon={<action.Icon aria-hidden="true" />}
				loading={isScheduling || isUnscheduling}
			>
				{label}
			</Button>
		);
	}

	const triggerLabel =
		state === "published-with-changes"
			? t`Publish changes`
			: state === "scheduled"
				? t`Scheduled`
				: state === "update-scheduled"
					? t`Scheduled update`
					: state === "published-scheduled"
						? t`Scheduled publication`
						: t`Publish`;

	return (
		<DropdownMenu
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				onMenuOpenChange?.(nextOpen);
			}}
		>
			<DropdownMenu.Trigger
				render={
					<Button
						type="button"
						variant="primary"
						size={size}
						className={cn(fullWidth && "w-full", "[&>span:last-child]:w-full")}
						loading={isScheduling || isUnscheduling}
						aria-haspopup="menu"
						aria-expanded={open}
					>
						<span className="relative flex w-full min-w-0 items-center justify-center">
							<span className="max-w-full truncate px-5 text-center">{triggerLabel}</span>
							<CaretDown className="absolute end-0 size-3 shrink-0" aria-hidden="true" />
						</span>
					</Button>
				}
			/>
			<DropdownMenu.Content
				align="end"
				className="w-80 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] p-1.5 transition-[transform,scale,opacity] duration-150 data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[instant]:duration-0 data-[starting-style]:scale-90 data-[starting-style]:opacity-0 motion-reduce:transition-none"
			>
				{actions.map(({ kind, label, Icon: ActionIcon, onSelect }) => (
					<DropdownMenu.Item
						key={kind}
						icon={
							<span className="me-2 flex h-lh shrink-0 items-center">
								<ActionIcon className="size-4" aria-hidden="true" />
							</span>
						}
						disabled={isScheduling || isUnscheduling}
						onClick={onSelect}
						className="px-2.5 py-1.5"
					>
						<Text as="span" bold>
							{label}
						</Text>
					</DropdownMenu.Item>
				))}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

/**
 * Single action row pinned above the settings panel body. Publish-state
 * context lives in the Publish section below so the sidebar has one action
 * surface and one status surface.
 *
 * Deliberately NOT memoized — it exists so high-frequency props
 * (isDirty, isSaving, isAutosaving) stop here instead of busting the
 * memoized panel body below it.
 */
export function SettingsActionBar({
	collectionLabel,
	isNew,
	isDirty,
	isSaving,
	isAutosaving,
	saveDisabled,
	isLive,
	hasPendingChanges,
	publishingState,
	canSchedule,
	isScheduling,
	isUnscheduling,
	liveViewUrl,
	supportsPreview,
	isLoadingPreview,
	onPreview,
	onPublish,
	onUnpublish,
	onOpenSchedule,
	onUnschedule,
	onMenuOpenChange,
	announceSaveStatus,
}: SettingsActionBarProps) {
	const { t } = useLingui();

	return (
		<div className="flex shrink-0 flex-wrap items-stretch gap-2 border-b px-4 py-3">
			<SettingsActionSlot>
				<SaveButton
					type="submit"
					size="sm"
					isDirty={isDirty}
					isSaving={isSaving || Boolean(isAutosaving)}
					announce={announceSaveStatus}
					disabled={saveDisabled}
				/>
			</SettingsActionSlot>
			{liveViewUrl && (
				<SettingsActionSlot>
					<LinkButton
						href={liveViewUrl}
						external
						variant="outline"
						size="sm"
						icon={<ArrowSquareOut />}
					>
						{t`Live View`}
					</LinkButton>
				</SettingsActionSlot>
			)}
			{!isNew && supportsPreview && (
				<SettingsActionSlot>
					<PreviewButton
						size="sm"
						hasPendingChanges={hasPendingChanges}
						isLoadingPreview={isLoadingPreview}
						onPreview={onPreview}
					/>
				</SettingsActionSlot>
			)}
			{!isNew && (
				<SettingsActionSlot>
					<PublishActions
						collectionLabel={collectionLabel}
						isNew={isNew}
						isLive={isLive}
						hasPendingChanges={hasPendingChanges}
						publishingState={publishingState}
						canSchedule={canSchedule}
						isScheduling={isScheduling}
						isUnscheduling={isUnscheduling}
						onPublish={onPublish}
						onUnpublish={onUnpublish}
						onOpenSchedule={onOpenSchedule}
						onUnschedule={onUnschedule}
						onMenuOpenChange={onMenuOpenChange}
						size="sm"
						fullWidth
					/>
				</SettingsActionSlot>
			)}
		</div>
	);
}

export interface ContentSettingsPanelProps {
	collection: string;
	item?: ContentItem | null;
	isNew?: boolean;
	manifest?: AdminManifest | null;
	/** Locale this entry is bound to (URL `?locale=` for new entries). */
	entryLocale?: string | null;
	slug: string;
	onSlugChange: (value: string) => void;
	status: string;
	supportsDrafts: boolean;
	isLive: boolean;
	hasPendingChanges: boolean;
	publishingState?: ContentPublishingState;
	supportsRevisions: boolean;
	onPublishedAtChange?: (publishedAt: string) => void | Promise<void>;
	isUpdatingPublishedAt?: boolean;
	onDiscardDraft?: () => void;
	onDelete?: () => void;
	isDeleting?: boolean;
	currentUser?: CurrentUserInfo;
	users?: UserListItem[];
	onAuthorChange?: (authorId: string | null) => void;
	activeBylines: BylineCreditInput[];
	inferredByline?: BylineSummary | null;
	availableBylines?: BylineSummary[];
	availableBylinesLoaded?: boolean;
	onBylinesChange: (next: BylineCreditInput[]) => void;
	onQuickCreateByline?: (input: { slug: string; displayName: string }) => Promise<BylineSummary>;
	onQuickEditByline?: (
		bylineId: string,
		input: { slug: string; displayName: string },
	) => Promise<BylineSummary>;
	i18n?: { defaultLocale: string; locales: string[] };
	translations?: TranslationSummary[];
	onTranslate?: (locale: string) => void;
	hasSeo: boolean;
	onSeoChange?: (seo: ContentSeoInput) => void;
	/** portableText editor for the document outline (null when none mounted) */
	portableTextEditor: Editor | null;
	/** When set, the panel shows the block's detail panel instead of settings */
	blockSidebarPanel: BlockSidebarPanel | null;
	onBlockSidebarClose: () => void;
	onBlockSidebarDelete: () => void;
}

/**
 * Content settings sidebar: publish controls, ownership, bylines,
 * translations, taxonomies, SEO, document outline, and revision history.
 *
 * Memoized — ContentEditor re-renders on every keystroke (formData state),
 * and this subtree is expensive (queries + lists). All handler props must be
 * referentially stable or the memo is defeated.
 */
export const ContentSettingsPanel = React.memo(function ContentSettingsPanel({
	collection,
	item,
	isNew,
	manifest,
	entryLocale,
	slug,
	onSlugChange,
	supportsDrafts,
	isLive,
	hasPendingChanges,
	publishingState,
	supportsRevisions,
	onPublishedAtChange,
	isUpdatingPublishedAt,
	onDiscardDraft,
	onDelete,
	isDeleting,
	currentUser,
	users,
	onAuthorChange,
	activeBylines,
	inferredByline,
	availableBylines,
	availableBylinesLoaded,
	onBylinesChange,
	onQuickCreateByline,
	onQuickEditByline,
	i18n,
	translations,
	onTranslate,
	hasSeo,
	onSeoChange,
	portableTextEditor,
	blockSidebarPanel,
	onBlockSidebarClose,
	onBlockSidebarDelete,
}: ContentSettingsPanelProps) {
	const { t, i18n: lingui } = useLingui();
	const navigate = useNavigate();
	const pluginAdmins = usePluginAdmins();
	const extensionPanels = React.useMemo(
		() =>
			!isNew && item
				? resolveContentEditorPanels(
						pluginAdmins,
						collection,
						currentUser?.role ?? 0,
						manifest?.plugins,
					)
				: [],
		[collection, currentUser?.role, isNew, item, manifest?.plugins, pluginAdmins],
	);

	const [isReorderingSections, setIsReorderingSections] = React.useState(false);
	const [datesOpen, setDatesOpen] = React.useState(false);
	const showDiscard = !isNew && supportsDrafts && hasPendingChanges && !!onDiscardDraft;
	const activeEntryLocale = item?.locale ?? entryLocale ?? undefined;
	const resolvedPublishingState =
		publishingState ??
		getContentPublishingState({ isLive, hasPendingChanges, scheduledAt: item?.scheduledAt });
	const hasApplicableTaxonomies = useHasApplicableTaxonomies(
		collection,
		activeEntryLocale,
		i18n?.defaultLocale,
	);
	const canUpdatePublishedDate =
		item?.publishedAt != null && (currentUser?.role ?? 0) >= ROLE_EDITOR && !!onPublishedAtChange;
	const contentLocale = item?.locale ?? entryLocale ?? manifest?.contentLocale?.defaultLocale;
	const usesImplicitEnglish = manifest?.contentLocale?.implicit === true && contentLocale === "en";
	const publicationEntryKey = `${item?.id ?? "new"}:${activeEntryLocale ?? ""}`;
	const showPublishingRelationship = supportsDrafts || Boolean(item?.scheduledAt);
	React.useEffect(() => setDatesOpen(false), [item?.id, item?.locale]);

	if (blockSidebarPanel) {
		// A block requesting the sidebar replaces the default sections.
		return blockSidebarPanel.type === "image" ? (
			<ImageDetailPanel
				attributes={blockSidebarPanel.attrs as unknown as ImageAttributes}
				onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
				onReplace={(attrs) =>
					blockSidebarPanel.onReplace(attrs as unknown as Record<string, unknown>)
				}
				onDelete={onBlockSidebarDelete}
				onClose={onBlockSidebarClose}
				inlineClassName="rounded-none border-0"
				stickyFooter
				inline
			/>
		) : blockSidebarPanel.type === "gallery" ? (
			<div className="p-4">
				<GalleryDetailPanel
					attributes={blockSidebarPanel.attrs as unknown as GalleryAttributes}
					onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
					onDelete={onBlockSidebarDelete}
					onClose={onBlockSidebarClose}
					inline
				/>
			</div>
		) : null;
	}

	return (
		// The Kumo Sidebar wrapper sets `whitespace-nowrap` for its collapse
		// animation, which would stop long field descriptions from wrapping.
		<div className="flex flex-col whitespace-normal">
			<SortableContentSettingsSections
				collection={collection}
				userId={currentUser?.id}
				onSortingChange={setIsReorderingSections}
			>
				<SortableContentSettingsSection id="publish" label={t`Publish`}>
					<div className="p-4">
						<Text bold as="h3" DANGEROUS_className="mb-4">
							{t`Publish`}
						</Text>
						<div className="space-y-4">
							<Input
								label={t`Slug`}
								value={slug}
								onChange={(e) => onSlugChange(e.target.value)}
								placeholder="my-post-slug"
							/>
							{contentLocale ? (
								<div className="flex flex-wrap items-center gap-1.5">
									<Label>{t`Content locale`}</Label>
									<Badge variant="secondary">{contentLocale.toUpperCase()}</Badge>
									{usesImplicitEnglish ? (
										<Tooltip
											content={
												<span className="block max-w-64 text-pretty">
													{t`English is used because no content locale is configured. Content locale is stored with the entry and is separate from your admin language.`}
												</span>
											}
											delay={0}
											closeDelay={0}
											render={
												<Button
													type="button"
													variant="ghost"
													shape="square"
													size="xs"
													icon={<Info aria-hidden="true" />}
													className="text-kumo-subtle hover:text-kumo-default"
													aria-label={t`Why English is used`}
												/>
											}
										/>
									) : null}
								</div>
							) : null}
						</div>

						{showPublishingRelationship || item ? (
							<LayerCard
								render={<div role="group" aria-label={t`Publishing summary`} />}
								className="mt-5 overflow-hidden p-0"
							>
								{showPublishingRelationship ? (
									<PublishingVersionRelationship
										publishingState={resolvedPublishingState}
										supportsDrafts={supportsDrafts}
										scheduledAt={item?.scheduledAt}
										locale={lingui.locale}
										onDiscardDraft={showDiscard ? onDiscardDraft : undefined}
									/>
								) : null}

								{item ? (
									<div
										data-testid="content-timestamps"
										className={cn(
											"px-3 py-1.5",
											showPublishingRelationship && "border-t border-kumo-line",
										)}
									>
										{item.publishedAt ? (
											<dl>
												{canUpdatePublishedDate && onPublishedAtChange ? (
													<div>
														<dt className="sr-only">{t`Publication date`}</dt>
														<dd>
															<PublicationDateDialog
																entryKey={publicationEntryKey}
																publishedAt={item.publishedAt}
																label={t`Publication date`}
																formattedValue={formatPublishingInstant(
																	item.publishedAt,
																	lingui.locale,
																)}
																isPending={isUpdatingPublishedAt}
																onPublishedAtChange={onPublishedAtChange}
															/>
														</dd>
													</div>
												) : (
													<TimestampRow label={t`Publication date`}>
														<TimestampValue value={item.publishedAt} locale={lingui.locale} />
													</TimestampRow>
												)}
											</dl>
										) : null}

										<Collapsible.Root open={datesOpen} onOpenChange={setDatesOpen}>
											<Collapsible.Trigger
												render={
													<Button
														type="button"
														variant="ghost"
														className={cn(
															"-mx-2 h-9 w-[calc(100%+1rem)] min-w-0 justify-between overflow-hidden whitespace-nowrap px-2 py-1.5 font-normal",
															item.publishedAt && "mt-1",
														)}
													/>
												}
											>
												<Text as="span" variant="secondary" size="sm">
													{t`Created and updated`}
												</Text>
												<CaretDown
													className={cn(
														"size-3 transition-transform duration-150 ease-out motion-reduce:transition-none",
														datesOpen && "rotate-180",
													)}
													aria-hidden="true"
												/>
											</Collapsible.Trigger>
											<Collapsible.Panel
												className="overflow-hidden duration-150 ease-out [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none"
												style={({ transitionStatus }) => ({
													height:
														transitionStatus === "starting" || transitionStatus === "ending"
															? 0
															: "var(--collapsible-panel-height)",
													transitionProperty: "height",
												})}
											>
												<dl className="grid gap-1.5 px-0 pt-1.5 pb-0.5">
													<TimestampRow label={t`Created`} size="sm">
														<TimestampValue
															value={item.createdAt}
															locale={lingui.locale}
															size="sm"
														/>
													</TimestampRow>
													<TimestampRow label={t`Updated`} size="sm">
														<TimestampValue
															value={item.updatedAt}
															locale={lingui.locale}
															size="sm"
														/>
													</TimestampRow>
												</dl>
											</Collapsible.Panel>
										</Collapsible.Root>
									</div>
								) : null}
							</LayerCard>
						) : null}
					</div>
				</SortableContentSettingsSection>

				{currentUser && currentUser.role >= ROLE_EDITOR && users && users.length > 0 && (
					<SortableContentSettingsSection id="ownership" label={t`Ownership`}>
						<div className="p-4">
							<Text bold as="h3" DANGEROUS_className="mb-4">
								{t`Ownership`}
							</Text>
							<AuthorSelector
								authorId={item?.authorId || null}
								users={users}
								onChange={onAuthorChange}
							/>
						</div>
					</SortableContentSettingsSection>
				)}

				{currentUser && currentUser.role >= ROLE_EDITOR && (
					<SortableContentSettingsSection id="bylines" label={t`Bylines`}>
						<div className="p-4">
							<div className="mb-4 flex items-center gap-1.5 pe-24">
								<Text bold as="h3">
									{t`Bylines`}
								</Text>
								<Tooltip
									content={
										<span className="block max-w-64 text-pretty">
											{t`Shown to readers in this order.`}
										</span>
									}
									delay={0}
									closeDelay={0}
									render={
										<Button
											type="button"
											variant="ghost"
											shape="square"
											size="xs"
											icon={<Info aria-hidden="true" />}
											className="text-kumo-subtle hover:text-kumo-default"
											aria-label={t`Why are bylines shown in this order?`}
										/>
									}
								/>
							</div>
							<BylineCreditsEditor
								key={`${collection}:${item?.id ?? "new"}:${item?.locale ?? entryLocale ?? ""}`}
								credits={activeBylines}
								inferredByline={inferredByline}
								bylines={availableBylines ?? []}
								selectedBylineDetails={item?.bylines
									?.filter((entry) => entry.source !== "inferred")
									.map((entry) => entry.byline)}
								bylinesLoaded={availableBylinesLoaded}
								onChange={onBylinesChange}
								onQuickCreate={onQuickCreateByline}
								onQuickEdit={onQuickEditByline}
								// Existing entry: use its own locale. New entry: use the
								// URL `?locale=` (passed in via `entryLocale`).
								entryLocale={item?.locale ?? entryLocale}
								i18n={i18n}
							/>
						</div>
					</SortableContentSettingsSection>
				)}

				{i18n && item && !isNew && (
					<SortableContentSettingsSection id="translations" label={t`Translations`}>
						<div className="p-4">
							<TranslationsPanel
								locales={i18n.locales}
								defaultLocale={i18n.defaultLocale}
								currentLocale={item.locale ?? undefined}
								translations={translations ?? []}
								onOpen={(tr) =>
									navigate({
										to: "/content/$collection/$id",
										params: { collection, id: tr.id },
										search: { locale: tr.locale },
									})
								}
								onCreate={onTranslate}
							/>
						</div>
					</SortableContentSettingsSection>
				)}

				{/* Do not register an empty sortable row when this collection has no taxonomies. */}
				{item && hasApplicableTaxonomies && (
					<SortableContentSettingsSection id="taxonomies" label={t`Taxonomies`}>
						<TaxonomySidebar
							className="p-4"
							collection={collection}
							entryId={item.id}
							entryLocale={activeEntryLocale}
							defaultLocale={i18n?.defaultLocale}
							canManageTaxonomies={(currentUser?.role ?? 0) >= ROLE_EDITOR}
						/>
					</SortableContentSettingsSection>
				)}

				{hasSeo && !isNew && onSeoChange && (
					<SortableContentSettingsSection id="seo" label={t`SEO`}>
						<div className="p-4">
							<Text bold as="h3" DANGEROUS_className="mb-4">
								{t`SEO`}
							</Text>
							<SeoPanel
								contentKey={item?.id ?? `new:${collection}`}
								seo={item?.seo}
								onChange={onSeoChange}
								defaultTitle={typeof item?.data?.title === "string" ? item.data.title : null}
								defaultDescription={
									typeof item?.data?.excerpt === "string" ? item.data.excerpt : null
								}
							/>
						</div>
					</SortableContentSettingsSection>
				)}

				{item &&
					extensionPanels.map(({ pluginId, extension }) => {
						const Panel = extension.component;
						const sectionId = `plugin:${pluginId}:${extension.id}`;
						const title = lingui._({ id: extension.title, message: extension.title });

						return (
							<SortableContentSettingsSection key={sectionId} id={sectionId} label={title}>
								<div className="min-w-0 p-4">
									<Text bold as="h3" DANGEROUS_className="mb-4">
										{title}
									</Text>
									<ContentEditorPanelBoundary
										key={`${collection}:${item.id}`}
										pluginId={pluginId}
										panelId={extension.id}
									>
										<div className="min-w-0 max-w-full">
											<Panel
												collection={collection}
												entry={item}
												locale={item.locale ?? entryLocale ?? undefined}
											/>
										</div>
									</ContentEditorPanelBoundary>
								</div>
							</SortableContentSettingsSection>
						);
					})}

				{portableTextEditor && (
					<SortableContentSettingsSection id="outline" label={t`Outline`} disclosure>
						<div className="p-4">
							<DocumentOutline editor={portableTextEditor} reserveHeaderEnd />
						</div>
					</SortableContentSettingsSection>
				)}

				{!isNew && item && supportsRevisions && (
					<SortableContentSettingsSection id="revisions" label={t`Revisions`} disclosure>
						<div className="p-4">
							<RevisionHistory collection={collection} entryId={item.id} reserveHeaderEnd />
						</div>
					</SortableContentSettingsSection>
				)}
			</SortableContentSettingsSections>

			{!isNew && onDelete && (
				<div
					data-testid="content-trash-actions"
					aria-hidden={isReorderingSections || undefined}
					className={cn(
						"border-t bg-kumo-base p-4",
						isReorderingSections && "invisible pointer-events-none",
					)}
				>
					<Dialog.Root disablePointerDismissal>
						<Dialog.Trigger
							render={(p) => (
								<Button
									{...p}
									type="button"
									variant="ghost"
									className="w-full bg-kumo-danger/10 text-kumo-danger hover:bg-kumo-danger/10 hover:text-kumo-danger"
									disabled={isDeleting}
									icon={isDeleting ? <Loader size="sm" /> : <Trash />}
								>
									{t`Move to Trash`}
								</Button>
							)}
						/>
						<Dialog className="p-6" size="sm">
							<Dialog.Title className="text-lg font-semibold">{t`Move to Trash?`}</Dialog.Title>
							<Dialog.Description className="text-kumo-subtle">
								{t`This will move the item to trash. You can restore it later from the trash.`}
							</Dialog.Description>
							<div className="mt-6 flex justify-end gap-2">
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="secondary">
											{t`Cancel`}
										</Button>
									)}
								/>
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="destructive" onClick={onDelete}>
											{t`Move to Trash`}
										</Button>
									)}
								/>
							</div>
						</Dialog>
					</Dialog.Root>
				</div>
			)}
		</div>
	);
});

interface AuthorSelectorProps {
	authorId: string | null;
	users: UserListItem[];
	onChange?: (authorId: string | null) => void;
}

function AuthorSelector({ authorId, users, onChange }: AuthorSelectorProps) {
	const { t } = useLingui();
	const currentAuthor = users.find((u) => u.id === authorId);

	const authorItems: Record<string, string> = { unassigned: t`Unassigned` };
	for (const user of users) {
		authorItems[user.id] = user.name || user.email;
	}

	return (
		<div className="space-y-2">
			<Select
				aria-label={t`Author`}
				className="w-full"
				value={authorId || "unassigned"}
				onValueChange={(value) =>
					onChange?.(value === "unassigned" || value === null ? null : value)
				}
				items={authorItems}
			>
				<Select.Option value="unassigned">
					<span className="text-kumo-subtle">{t`Unassigned`}</span>
				</Select.Option>
				{users.map((user) => (
					<Select.Option key={user.id} value={user.id}>
						<span className="flex items-center gap-2">
							{user.name || user.email}
							{user.name && <span className="text-xs text-kumo-subtle">({user.email})</span>}
						</span>
					</Select.Option>
				))}
			</Select>
			{currentAuthor && <p className="text-xs text-kumo-subtle">{currentAuthor.email}</p>}
		</div>
	);
}
