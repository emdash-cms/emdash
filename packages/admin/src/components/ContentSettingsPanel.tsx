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
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowSquareOut, Eye, EyeSlash, Trash, Upload, X } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import type {
	BylineCreditInput,
	BylineSummary,
	ContentItem,
	ContentSeoInput,
	TranslationSummary,
	UserListItem,
} from "../lib/api";
import { fetchBylines } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks.js";
import { slugify } from "../lib/utils";
import type { CurrentUserInfo } from "./ContentEditor.js";
import { DocumentOutline } from "./editor/DocumentOutline";
import { ImageDetailPanel } from "./editor/ImageDetailPanel";
import type { ImageAttributes } from "./editor/ImageDetailPanel";
import type { BlockSidebarPanel } from "./PortableTextEditor";
import { RevisionHistory } from "./RevisionHistory";
import { RouterLinkButton } from "./RouterLinkButton.js";
import { SaveButton } from "./SaveButton";
import { SeoPanel } from "./SeoPanel";
import { TaxonomySidebar } from "./TaxonomySidebar";
import { TranslationsPanel } from "./TranslationsPanel.js";

// Editor role level (40) from @emdash-cms/auth
const ROLE_EDITOR = 40;

/** Format scheduled date for display */
function formatScheduledDate(dateStr: string | null) {
	if (!dateStr) return null;
	const date = new Date(dateStr);
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
	isNew?: boolean;
	isLive: boolean;
	hasPendingChanges: boolean;
	onPublish?: () => void;
	onUnpublish?: () => void;
	size?: "sm";
}

export function PublishActions({
	isNew,
	isLive,
	hasPendingChanges,
	onPublish,
	onUnpublish,
	size,
}: PublishActionsProps) {
	const { t } = useLingui();

	if (isNew) return null;
	if (!isLive) {
		return (
			<Button type="button" variant="secondary" size={size} onClick={onPublish} icon={<Upload />}>
				{t`Publish`}
			</Button>
		);
	}
	if (hasPendingChanges) {
		return (
			<Button type="button" variant="primary" size={size} onClick={onPublish} icon={<Upload />}>
				{t`Publish changes`}
			</Button>
		);
	}
	return (
		<Button type="button" variant="outline" size={size} onClick={onUnpublish} icon={<EyeSlash />}>
			{t`Unpublish`}
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
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
			<SaveButton
				type="submit"
				size="sm"
				isDirty={isDirty}
				isSaving={isSaving || Boolean(isAutosaving)}
				announce={announceSaveStatus}
				disabled={saveDisabled}
			/>
			{liveViewUrl && (
				<LinkButton
					href={liveViewUrl}
					external
					variant="outline"
					size="sm"
					icon={<ArrowSquareOut />}
				>
					{t`Live View`}
				</LinkButton>
			)}
			{!isNew && supportsPreview && (
				<PreviewButton
					size="sm"
					hasPendingChanges={hasPendingChanges}
					isLoadingPreview={isLoadingPreview}
					onPreview={onPreview}
				/>
			)}
			<PublishActions
				isNew={isNew}
				isLive={isLive}
				hasPendingChanges={hasPendingChanges}
				onPublish={onPublish}
				onUnpublish={onUnpublish}
				size="sm"
			/>
		</div>
	);
}

export interface ContentSettingsPanelProps {
	collection: string;
	item?: ContentItem | null;
	isNew?: boolean;
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
	onDiscardDraft?: () => void;
	onDelete?: () => void;
	isDeleting?: boolean;
	currentUser?: CurrentUserInfo;
	users?: UserListItem[];
	onAuthorChange?: (authorId: string | null) => void;
	activeBylines: BylineCreditInput[];
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
	onDiscardDraft,
	onDelete,
	isDeleting,
	currentUser,
	users,
	onAuthorChange,
	activeBylines,
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
	const { t } = useLingui();
	const navigate = useNavigate();

	const [scheduleDate, setScheduleDate] = React.useState<string>("");
	const [showScheduler, setShowScheduler] = React.useState(false);
	const showDiscard = !isNew && supportsDrafts && hasPendingChanges && !!onDiscardDraft;

	const handleScheduleSubmit = () => {
		if (scheduleDate && onSchedule) {
			const date = new Date(scheduleDate);
			onSchedule(date.toISOString());
			setShowScheduler(false);
			setScheduleDate("");
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
		) : null;
	}

	return (
		// The Kumo Sidebar wrapper sets `whitespace-nowrap` for its collapse
		// animation, which would stop long field descriptions from wrapping.
		<div className="flex flex-col whitespace-normal">
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
					<div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
							<Label>{t`Status`}</Label>
							{supportsDrafts ? (
								<>
									{isLive && <Badge variant="success">{t`Published`}</Badge>}
									{hasPendingChanges && <Badge variant="secondary">{t`Pending changes`}</Badge>}
									{!isLive && !hasSchedule && <Badge variant="secondary">{t`Draft`}</Badge>}
									{hasSchedule && <Badge variant="outline">{t`Scheduled`}</Badge>}
								</>
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
				</div>

				{item && (
					<dl className="mt-4 border-t pt-4 space-y-1 text-xs text-kumo-subtle">
						<div className="flex items-center justify-between gap-2">
							<dt>{t`Created`}</dt>
							<dd>{new Date(item.createdAt).toLocaleString()}</dd>
						</div>
						<div className="flex items-center justify-between gap-2">
							<dt>{t`Updated`}</dt>
							<dd>{new Date(item.updatedAt).toLocaleString()}</dd>
						</div>
					</dl>
				)}
			</div>

			{currentUser && currentUser.role >= ROLE_EDITOR && users && users.length > 0 && (
				<div className="p-4 border-t">
					<Text bold as="h3" DANGEROUS_className="mb-4">
						{t`Ownership`}
					</Text>
					<AuthorSelector
						authorId={item?.authorId || null}
						users={users}
						onChange={onAuthorChange}
					/>
				</div>
			)}

			{currentUser && currentUser.role >= ROLE_EDITOR && (
				<div className="p-4 border-t">
					<Text bold as="h3" DANGEROUS_className="mb-4">
						{t`Bylines`}
					</Text>
					<BylineCreditsEditor
						credits={activeBylines}
						bylines={availableBylines ?? []}
						selectedBylineDetails={item?.bylines?.map((entry) => entry.byline)}
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
			)}

			{i18n && item && !isNew && (
				<div className="p-4 border-t">
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
			)}

			{/* Taxonomy selector — renders nothing (no chrome) when no taxonomies
			    apply to this collection, so it owns its own section border. */}
			{item && (
				<TaxonomySidebar
					className="p-4 border-t"
					collection={collection}
					entryId={item.id}
					entryLocale={item.locale ?? entryLocale}
				/>
			)}

			{hasSeo && !isNew && onSeoChange && (
				<div className="p-4 border-t">
					<Text bold as="h3" DANGEROUS_className="mb-4">
						{t`SEO`}
					</Text>
					<SeoPanel
						contentKey={item?.id ?? `new:${collection}`}
						seo={item?.seo}
						onChange={onSeoChange}
					/>
				</div>
			)}

			{portableTextEditor && (
				<div className="p-4 border-t">
					<DocumentOutline editor={portableTextEditor} />
				</div>
			)}

			{!isNew && item && supportsRevisions && (
				<div className="p-4 border-t">
					<RevisionHistory collection={collection} entryId={item.id} />
				</div>
			)}

			{!isNew && onDelete && (
				<div className="border-t p-4">
					<Dialog.Root disablePointerDismissal>
						<Dialog.Trigger
							render={(p) => (
								<Button
									{...p}
									type="button"
									variant="outline"
									className="w-full text-kumo-danger hover:text-kumo-danger"
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

interface BylineCreditsEditorProps {
	credits: BylineCreditInput[];
	bylines: BylineSummary[];
	/**
	 * Full byline details for the entry's already-selected credits. Seeded from
	 * the saved entry so credited bylines always render their name/slug even when
	 * they fall outside the initial (unsearched) picker list.
	 */
	selectedBylineDetails?: BylineSummary[];
	onChange: (bylines: BylineCreditInput[]) => void;
	onQuickCreate?: (input: { slug: string; displayName: string }) => Promise<BylineSummary>;
	onQuickEdit?: (
		bylineId: string,
		input: { slug: string; displayName: string },
	) => Promise<BylineSummary>;
	/**
	 * Locale of the entry being edited. When the picker comes back empty and
	 * the install is multi-locale, the empty-state copy and CTA link are
	 * scoped to this locale (post-migration 040, the picker is strict
	 * per-locale — see the bylines manager flow).
	 */
	entryLocale?: string | null;
	/** i18n config from the manifest. When set with >1 locales, the editor renders the locale-scoped empty-state. */
	i18n?: { defaultLocale: string; locales: string[] } | null;
	/** Suppresses the empty-state until the picker query resolves. Defaults to true. */
	bylinesLoaded?: boolean;
}

function BylineCreditsEditor({
	credits,
	bylines,
	selectedBylineDetails,
	onChange,
	onQuickCreate,
	onQuickEdit,
	entryLocale,
	i18n,
	bylinesLoaded = true,
}: BylineCreditsEditorProps) {
	const { t } = useLingui();
	const [search, setSearch] = React.useState("");
	const debouncedSearch = useDebouncedValue(search, 300);
	const [quickName, setQuickName] = React.useState("");
	const [quickSlug, setQuickSlug] = React.useState("");
	const [quickError, setQuickError] = React.useState<string | null>(null);
	const [isCreating, setIsCreating] = React.useState(false);
	const [editBylineId, setEditBylineId] = React.useState<string | null>(null);
	const [editName, setEditName] = React.useState("");
	const [editSlug, setEditSlug] = React.useState("");
	const [editError, setEditError] = React.useState<string | null>(null);
	const [isEditing, setIsEditing] = React.useState(false);

	// Server-side search so the picker isn't limited to the first page of
	// bylines (previously capped at 100 with no way to find the rest). When the
	// search box is empty we fall back to the parent-provided initial list.
	const trimmedSearch = debouncedSearch.trim();
	const searchEnabled = trimmedSearch.length > 0;
	const searchResults = useQuery({
		queryKey: ["bylines", "credit-picker", entryLocale ?? null, trimmedSearch],
		queryFn: () =>
			fetchBylines({ search: trimmedSearch, locale: entryLocale ?? undefined, limit: 20 }),
		enabled: searchEnabled,
		placeholderData: keepPreviousData,
	});

	const resultPool = searchEnabled ? (searchResults.data?.items ?? []) : bylines;
	const hasMoreResults = searchEnabled ? !!searchResults.data?.nextCursor : bylines.length >= 100;

	// Resolve credited bylines to their full details for display. Selected rows
	// come from the parent-provided details so they keep rendering even when the
	// current search results no longer include them.
	const bylineMap = React.useMemo(() => {
		const map = new Map<string, BylineSummary>();
		for (const b of selectedBylineDetails ?? []) map.set(b.id, b);
		for (const b of bylines) map.set(b.id, b);
		for (const b of searchResults.data?.items ?? []) map.set(b.id, b);
		return map;
	}, [selectedBylineDetails, bylines, searchResults.data?.items]);

	const availableToAdd = resultPool.filter((b) => !credits.some((c) => c.bylineId === b.id));

	const addByline = (bylineId: string) => {
		if (credits.some((c) => c.bylineId === bylineId)) return;
		onChange([...credits, { bylineId, roleLabel: null }]);
	};

	const move = (index: number, direction: -1 | 1) => {
		const target = index + direction;
		if (target < 0 || target >= credits.length) return;
		const next = [...credits];
		const [moved] = next.splice(index, 1);
		if (!moved) return;
		next.splice(target, 0, moved);
		onChange(next);
	};

	const resetQuickCreate = () => {
		setQuickName("");
		setQuickSlug("");
		setQuickError(null);
	};

	const openEditByline = (byline: BylineSummary) => {
		setEditBylineId(byline.id);
		setEditName(byline.displayName);
		setEditSlug(byline.slug);
		setEditError(null);
	};

	const resetQuickEdit = () => {
		setEditBylineId(null);
		setEditName("");
		setEditSlug("");
		setEditError(null);
	};

	// Multi-locale install with no bylines at the entry's locale: show a
	// CTA to the byline manager, scoped to that locale. Quick-create
	// still works inline.
	const isMultiLocale = !!i18n && i18n.locales.length > 1;
	const showLocaleEmptyState =
		isMultiLocale && bylinesLoaded && bylines.length === 0 && !!entryLocale;

	return (
		<div className="space-y-4">
			{showLocaleEmptyState && (
				<div className="rounded-lg border border-dashed p-3 text-sm space-y-2">
					<p className="text-kumo-subtle">
						{t`No bylines available in ${entryLocale}. Create a variant from the Bylines page before crediting one on this entry.`}
					</p>
					<RouterLinkButton
						to="/bylines"
						search={{ locale: entryLocale ?? undefined }}
						variant="secondary"
						size="sm"
					>
						{t`Manage bylines in ${entryLocale}`}
					</RouterLinkButton>
				</div>
			)}
			<div className="space-y-2">
				<Input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={t`Search bylines to add...`}
					aria-label={t`Search bylines`}
					className="w-full"
				/>
				{searchEnabled && searchResults.isLoading ? (
					<p className="text-sm text-kumo-subtle">{t`Searching...`}</p>
				) : availableToAdd.length > 0 ? (
					<ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
						{availableToAdd.map((b) => (
							<li key={b.id}>
								<button
									type="button"
									className="flex w-full items-center justify-between gap-2 p-2 text-start hover:bg-kumo-tint"
									onClick={() => addByline(b.id)}
								>
									<span className="min-w-0">
										<span className="block truncate text-sm font-medium">{b.displayName}</span>
										<span className="block truncate text-xs text-kumo-subtle">{b.slug}</span>
									</span>
									<span className="text-xs text-kumo-subtle">{t`Add`}</span>
								</button>
							</li>
						))}
					</ul>
				) : searchEnabled && searchResults.isError ? (
					<p className="text-sm text-kumo-danger">{t`Couldn't search bylines. Please try again.`}</p>
				) : searchEnabled ? (
					<p className="text-sm text-kumo-subtle">{t`No matching bylines.`}</p>
				) : null}
				{hasMoreResults && (
					<p className="text-xs text-kumo-subtle">{t`Keep typing to narrow down more bylines.`}</p>
				)}
			</div>

			{credits.length > 0 ? (
				<div className="space-y-2">
					{credits.map((credit, index) => {
						const byline = bylineMap.get(credit.bylineId);
						if (!byline) return null;
						return (
							<div key={`${credit.bylineId}-${index}`} className="rounded-lg border p-2 space-y-2">
								<div className="grid min-w-0 items-start gap-2">
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">{byline.displayName}</p>
										<p className="truncate text-xs text-kumo-subtle">{byline.slug}</p>
									</div>
									<div className="flex min-w-0 flex-wrap gap-1">
										<Button type="button" variant="ghost" size="sm" onClick={() => move(index, -1)}>
											{t`Up`}
										</Button>
										<Button type="button" variant="ghost" size="sm" onClick={() => move(index, 1)}>
											{t`Down`}
										</Button>
										{onQuickEdit && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => openEditByline(byline)}
											>
												{t`Edit`}
											</Button>
										)}
										<Button
											type="button"
											variant="destructive"
											size="sm"
											onClick={() => onChange(credits.filter((_, i) => i !== index))}
										>
											{t`Remove`}
										</Button>
									</div>
								</div>
								<Input
									label={t`Role label`}
									value={credit.roleLabel ?? ""}
									onChange={(e) => {
										const next = [...credits];
										const current = next[index];
										if (!current) return;
										next[index] = {
											...current,
											roleLabel: e.target.value || null,
										};
										onChange(next);
									}}
								/>
							</div>
						);
					})}
				</div>
			) : (
				<p className="text-sm text-kumo-subtle">{t`No bylines selected.`}</p>
			)}

			{onQuickCreate && (
				<Dialog.Root>
					<Dialog.Trigger
						render={(p) => (
							<Button {...p} type="button" variant="secondary" className="w-full">
								{t`Quick create byline`}
							</Button>
						)}
					/>
					<Dialog className="p-6" size="sm">
						<Dialog.Title className="text-lg font-semibold">{t`Create byline`}</Dialog.Title>
						<div className="mt-4 space-y-3">
							<Input
								label={t`Display name`}
								value={quickName}
								onChange={(e) => {
									setQuickName(e.target.value);
									if (!quickSlug) setQuickSlug(slugify(e.target.value));
								}}
							/>
							<Input
								label={t`Slug`}
								value={quickSlug}
								onChange={(e) => setQuickSlug(e.target.value)}
							/>
							{quickError && <p className="text-sm text-kumo-danger">{quickError}</p>}
						</div>
						<div className="mt-6 flex justify-end gap-2">
							<Dialog.Close
								render={(p) => (
									<Button
										{...p}
										variant="secondary"
										onClick={(e) => {
											resetQuickCreate();
											p.onClick?.(e);
										}}
									>
										{t`Cancel`}
									</Button>
								)}
							/>
							<Button
								type="button"
								disabled={!quickName || !quickSlug || isCreating}
								onClick={async () => {
									setQuickError(null);
									setIsCreating(true);
									try {
										const created = await onQuickCreate({
											displayName: quickName,
											slug: quickSlug,
										});
										onChange([...credits, { bylineId: created.id, roleLabel: null }]);
										resetQuickCreate();
									} catch (err) {
										setQuickError(err instanceof Error ? err.message : t`Failed to create byline`);
									} finally {
										setIsCreating(false);
									}
								}}
							>
								{isCreating ? t`Creating...` : t`Create`}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}

			{onQuickEdit && editBylineId && (
				<Dialog.Root open onOpenChange={(open) => (!open ? resetQuickEdit() : undefined)}>
					<Dialog className="p-6" size="sm">
						<Dialog.Title className="text-lg font-semibold">{t`Edit byline`}</Dialog.Title>
						<div className="mt-4 space-y-3">
							<Input
								label={t`Display name`}
								value={editName}
								onChange={(e) => {
									setEditName(e.target.value);
									if (!editSlug) setEditSlug(slugify(e.target.value));
								}}
							/>
							<Input
								label={t`Slug`}
								value={editSlug}
								onChange={(e) => setEditSlug(e.target.value)}
							/>
							{editError && <p className="text-sm text-kumo-danger">{editError}</p>}
						</div>
						<div className="mt-6 flex justify-end gap-2">
							<Button type="button" variant="secondary" onClick={resetQuickEdit}>
								{t`Cancel`}
							</Button>
							<Button
								type="button"
								disabled={!editName || !editSlug || isEditing}
								onClick={async () => {
									setEditError(null);
									setIsEditing(true);
									try {
										await onQuickEdit(editBylineId, {
											displayName: editName,
											slug: editSlug,
										});
										resetQuickEdit();
									} catch (err) {
										setEditError(err instanceof Error ? err.message : t`Failed to update byline`);
									} finally {
										setIsEditing(false);
									}
								}}
							>
								{isEditing ? t`Saving...` : t`Save`}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}
		</div>
	);
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
