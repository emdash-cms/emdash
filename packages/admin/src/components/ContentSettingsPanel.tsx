import {
	Badge,
	Button,
	Dialog,
	Input,
	Label,
	LinkButton,
	Loader,
	Select,
	Text,
	Tooltip,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowSquareOut, Eye, EyeSlash, Info, Trash, Upload, X } from "@phosphor-icons/react";
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
import { fromDatetimeLocalInputValue, toDatetimeLocalInputValue } from "../lib/datetime-local.js";
import { usePluginAdmins } from "../lib/plugin-context";
import { cn, parseTimestamp } from "../lib/utils";
import { BylineCreditsEditor } from "./BylineCreditsEditor.js";
import type { CurrentUserInfo } from "./ContentEditor.js";
import { ContentStatusBadge, isContentStatusState } from "./ContentStatusBadge.js";
import { DocumentOutline } from "./editor/DocumentOutline";
import { GalleryDetailPanel } from "./editor/GalleryDetailPanel";
import type { GalleryAttributes } from "./editor/GalleryNode";
import { ImageDetailPanel } from "./editor/ImageDetailPanel";
import type { ImageAttributes } from "./editor/ImageDetailPanel";
import type { BlockSidebarPanel } from "./PortableTextEditor";
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

/** Format scheduled date for display */
function formatScheduledDate(dateStr: string | null) {
	if (!dateStr) return null;
	const date = parseTimestamp(dateStr);
	return date.toLocaleString();
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
	liveViewUrl?: string | null;
	supportsPreview?: boolean;
	isLoadingPreview?: boolean;
	onPreview?: () => void;
	onPublish?: () => void;
	onUnpublish?: () => void;
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
	onPublish?: () => void;
	onUnpublish?: () => void;
	size?: "sm";
}

export function PublishActions({
	collectionLabel,
	isNew,
	isLive,
	hasPendingChanges,
	onPublish,
	onUnpublish,
	size,
}: PublishActionsProps) {
	const { t } = useLingui();
	const itemLabel = collectionLabel ?? t`content`;

	if (isNew) return null;
	if (!isLive) {
		return (
			<Button type="button" variant="primary" size={size} onClick={onPublish} icon={<Upload />}>
				{t`Publish`}
			</Button>
		);
	}
	if (hasPendingChanges) {
		return (
			<Button type="button" variant="primary" size={size} onClick={onPublish} icon={<Upload />}>
				{t`Publish`}
			</Button>
		);
	}
	return (
		<Button type="button" variant="outline" size={size} onClick={onUnpublish} icon={<EyeSlash />}>
			{t`Unpublish ${itemLabel}`}
		</Button>
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
	liveViewUrl,
	supportsPreview,
	isLoadingPreview,
	onPreview,
	onPublish,
	onUnpublish,
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
						onPublish={onPublish}
						onUnpublish={onUnpublish}
						size="sm"
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
	hasSchedule: boolean;
	supportsRevisions: boolean;
	canSchedule: boolean;
	onSchedule?: (scheduledAt: string) => void;
	onUnschedule?: () => void;
	isScheduling?: boolean;
	onPublishedAtChange?: (publishedAt: string) => void;
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
	status,
	supportsDrafts,
	isLive,
	hasPendingChanges,
	hasSchedule,
	supportsRevisions,
	canSchedule,
	onSchedule,
	onUnschedule,
	isScheduling,
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

	const [scheduleDate, setScheduleDate] = React.useState<string>("");
	const [showScheduler, setShowScheduler] = React.useState(false);
	const storedPublishedDate = toDatetimeLocalInputValue(item?.publishedAt);
	const [publishedDate, setPublishedDate] = React.useState(storedPublishedDate);
	const [isReorderingSections, setIsReorderingSections] = React.useState(false);
	const showDiscard = !isNew && supportsDrafts && hasPendingChanges && !!onDiscardDraft;
	const activeEntryLocale = item?.locale ?? entryLocale ?? undefined;
	const hasApplicableTaxonomies = useHasApplicableTaxonomies(
		collection,
		activeEntryLocale,
		i18n?.defaultLocale,
	);
	const canUpdatePublishedDate =
		item?.publishedAt != null && (currentUser?.role ?? 0) >= ROLE_EDITOR && !!onPublishedAtChange;
	const contentLocale = item?.locale ?? entryLocale ?? manifest?.contentLocale?.defaultLocale;
	const usesImplicitEnglish = manifest?.contentLocale?.implicit === true && contentLocale === "en";

	React.useEffect(() => {
		setPublishedDate(storedPublishedDate);
	}, [item?.id, storedPublishedDate]);

	const handleScheduleSubmit = () => {
		if (scheduleDate && onSchedule) {
			const date = new Date(scheduleDate);
			onSchedule(date.toISOString());
			setShowScheduler(false);
			setScheduleDate("");
		}
	};

	const handlePublishedDateSubmit = () => {
		if (publishedDate && onPublishedAtChange) {
			onPublishedAtChange(fromDatetimeLocalInputValue(publishedDate));
		}
	};

	if (blockSidebarPanel) {
		// A block requesting the sidebar replaces the default sections.
		return blockSidebarPanel.type === "image" ? (
			<div className="p-4">
				<ImageDetailPanel
					attributes={blockSidebarPanel.attrs as unknown as ImageAttributes}
					onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
					onReplace={(attrs) =>
						blockSidebarPanel.onReplace(attrs as unknown as Record<string, unknown>)
					}
					onDelete={onBlockSidebarDelete}
					onClose={onBlockSidebarClose}
					inline
				/>
			</div>
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
							<div>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
									<Label>{t`Status`}</Label>
									{supportsDrafts ? (
										<>
											{isLive && <ContentStatusBadge state="published" />}
											{hasPendingChanges && <ContentStatusBadge state="pendingChanges" />}
											{!isLive && !hasSchedule && <ContentStatusBadge state="draft" />}
											{hasSchedule && <ContentStatusBadge state="scheduled" />}
										</>
									) : isContentStatusState(status) ? (
										<ContentStatusBadge state={status} />
									) : (
										<Badge variant="secondary">
											{status.charAt(0).toUpperCase() + status.slice(1)}
										</Badge>
									)}
								</div>
								{showDiscard && (
									<div className="mt-2">
										<DiscardDraftDialog
											onDiscard={onDiscardDraft}
											triggerVariant="outline"
											triggerSize="sm"
										/>
									</div>
								)}
							</div>
							{item?.scheduledAt && (
								<div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
									<p className="text-xs text-kumo-subtle">{t`Scheduled for: ${formatScheduledDate(item.scheduledAt)}`}</p>
									<Button type="button" variant="outline" size="sm" onClick={onUnschedule}>
										{t`Unschedule`}
									</Button>
								</div>
							)}

							{canSchedule && (
								<div className="pt-2">
									{showScheduler ? (
										<div className="space-y-2">
											<Input
												label={t`Schedule for`}
												type="datetime-local"
												value={scheduleDate}
												onChange={(e) => setScheduleDate(e.target.value)}
												min={new Date().toISOString().slice(0, 16)}
											/>
											<div className="flex gap-2">
												<Button
													type="button"
													size="sm"
													onClick={handleScheduleSubmit}
													disabled={!scheduleDate || isScheduling}
													icon={isScheduling ? <Loader size="sm" /> : undefined}
												>
													{t`Schedule`}
												</Button>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() => {
														setShowScheduler(false);
														setScheduleDate("");
													}}
												>
													{t`Cancel`}
												</Button>
											</div>
										</div>
									) : (
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="w-full"
											onClick={() => setShowScheduler(true)}
										>
											{t`Schedule for later`}
										</Button>
									)}
								</div>
							)}

							{canUpdatePublishedDate && (
								<div className="space-y-2 pt-2">
									<Input
										label={t`Publish date`}
										type="datetime-local"
										value={publishedDate}
										onChange={(event) => setPublishedDate(event.target.value)}
										disabled={isUpdatingPublishedAt}
									/>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={handlePublishedDateSubmit}
										disabled={
											!publishedDate ||
											publishedDate === storedPublishedDate ||
											isUpdatingPublishedAt
										}
										icon={isUpdatingPublishedAt ? <Loader size="sm" /> : undefined}
									>
										{t`Update publish date`}
									</Button>
								</div>
							)}
						</div>

						{item && (
							<dl
								data-testid="content-timestamps"
								className="mt-4 border-t pt-4 space-y-1 text-xs text-kumo-subtle"
							>
								<div className="flex items-center justify-between gap-2">
									<dt>{t`Created`}</dt>
									<dd>{parseTimestamp(item.createdAt).toLocaleString()}</dd>
								</div>
								<div className="flex items-center justify-between gap-2">
									<dt>{t`Updated`}</dt>
									<dd>{parseTimestamp(item.updatedAt).toLocaleString()}</dd>
								</div>
							</dl>
						)}
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
