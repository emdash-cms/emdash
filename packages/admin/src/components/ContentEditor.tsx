import {
	Badge,
	Button,
	Checkbox,
	Input,
	InputArea,
	Label,
	LinkButton,
	Select,
	Sidebar,
	Switch,
	useSidebar,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowSquareOut,
	Faders,
	Paperclip,
	X,
	ArrowsInSimple,
	ArrowsOutSimple,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import type {
	BylineCreditInput,
	BylineSummary,
	ContentItem,
	MediaItem,
	UserListItem,
	TranslationSummary,
} from "../lib/api";
import { getPreviewUrl, getDraftStatus } from "../lib/api";
import { fromDatetimeLocalInputValue, toDatetimeLocalInputValue } from "../lib/datetime-local.js";
import { formatFileSize, getFileIcon } from "../lib/media-utils";
import { usePluginAdmins } from "../lib/plugin-context.js";
import { contentUrl, isSafeUrl } from "../lib/url.js";
import { cn, slugify } from "../lib/utils";
import { getLocaleDir } from "../locales/config.js";
import { useLocale } from "../locales/useLocale.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { BlockKitFieldWidget } from "./BlockKitFieldWidget.js";
import {
	ContentSettingsPanel,
	DiscardDraftDialog,
	PreviewButton,
	PublishActions,
	SettingsActionBar,
} from "./ContentSettingsPanel.js";
import { ImageFieldRenderer, type ImageFieldValue } from "./ImageFieldRenderer.js";
import { PluginFieldErrorBoundary } from "./PluginFieldErrorBoundary.js";
import { RepeaterField } from "./RepeaterField.js";
import { RouterLinkButton } from "./RouterLinkButton.js";
import { SaveButton } from "./SaveButton.js";

/** Autosave debounce delay in milliseconds */
const AUTOSAVE_DELAY = 2000;
// Mirrors Header.tsx's h-[58px]; the fixed mobile sheet offsets its body by it.
const ADMIN_HEADER_HEIGHT_PX = 58;

function serializeEditorState(input: {
	data: Record<string, unknown>;
	slug: string;
	bylines: BylineCreditInput[];
}) {
	return JSON.stringify({
		data: input.data,
		slug: input.slug,
		bylines: input.bylines,
	});
}

import type { ContentSeoInput } from "../lib/api";
import { MediaPickerModal } from "./MediaPickerModal";
import {
	PortableTextEditor,
	type PluginBlockDef,
	type BlockSidebarPanel,
} from "./PortableTextEditor";

export interface FieldDescriptor {
	id?: string;
	kind: string;
	label?: string;
	required?: boolean;
	/**
	 * For `select` / `multiSelect`: the list of enum choices.
	 * For `json` fields driven by a plugin `widget`: arbitrary widget config.
	 */
	options?: Array<{ value: string; label: string }> | Record<string, unknown>;
	widget?: string;
	validation?: Record<string, unknown>;
}

/** Simplified user info for current user context */
export interface CurrentUserInfo {
	id: string;
	role: number;
}

export interface ContentEditorProps {
	collection: string;
	collectionLabel: string;
	item?: ContentItem | null;
	fields: Record<string, FieldDescriptor>;
	isNew?: boolean;
	/**
	 * Locale this entry is bound to. For existing entries this matches
	 * `item.locale`; for new entries it's the URL `?locale=` (or default).
	 * Threaded into the byline picker so the empty-state CTA links to the
	 * right locale on the Bylines manager.
	 */
	entryLocale?: string | null;
	/** Whether any content update is pending. Preserves main's operation gating. */
	isSaving?: boolean;
	/** Whether the current entry's editor save should drive visual feedback. */
	isSaveFeedbackActive?: boolean;
	onSave?: (payload: {
		data: Record<string, unknown>;
		slug?: string;
		bylines?: BylineCreditInput[];
	}) => void;
	/** Callback for autosave (debounced, skips revision creation) */
	onAutosave?: (payload: {
		data: Record<string, unknown>;
		slug?: string;
		bylines?: BylineCreditInput[];
	}) => void;
	/** Whether autosave is in progress */
	isAutosaving?: boolean;
	/** Whether the current entry's autosave should drive visual feedback. */
	isAutosaveFeedbackActive?: boolean;
	/** Entry-scoped token advanced after a successful autosave. */
	autosaveCompletionToken?: number;
	onPublish?: () => void;
	onUnpublish?: () => void;
	/** Callback to discard draft changes (revert to published version) */
	onDiscardDraft?: () => void;
	/** Callback to schedule for future publishing */
	onSchedule?: (scheduledAt: string) => void;
	/** Callback to cancel scheduling (revert to draft) */
	onUnschedule?: () => void;
	/** Whether scheduling is in progress */
	isScheduling?: boolean;
	/** Whether this collection supports drafts */
	supportsDrafts?: boolean;
	/** Whether this collection supports revisions */
	supportsRevisions?: boolean;
	/** Whether this collection supports preview */
	supportsPreview?: boolean;
	/** Current user (for permission checks) */
	currentUser?: CurrentUserInfo;
	/** Available users for author selection (only shown to editors+) */
	users?: UserListItem[];
	/** Callback when author is changed */
	onAuthorChange?: (authorId: string | null) => void;
	/** Available byline profiles */
	availableBylines?: BylineSummary[];
	/** Whether the parent's byline picker query has resolved. Suppresses the empty-state flash before first fetch. */
	availableBylinesLoaded?: boolean;
	/** Selected byline credits (controlled for new entries) */
	selectedBylines?: BylineCreditInput[];
	/** Callback when byline credits are changed */
	onBylinesChange?: (bylines: BylineCreditInput[]) => void;
	/** Callback for creating a byline inline from the editor */
	onQuickCreateByline?: (input: { slug: string; displayName: string }) => Promise<BylineSummary>;
	/** Callback for updating a byline inline from the editor */
	onQuickEditByline?: (
		bylineId: string,
		input: { slug: string; displayName: string },
	) => Promise<BylineSummary>;
	/** Callback when item is deleted (moved to trash) */
	onDelete?: () => void;
	/** Whether delete is in progress */
	isDeleting?: boolean;
	/** i18n config — present when multiple locales are configured */
	i18n?: { defaultLocale: string; locales: string[] };
	/** Existing translations for this content item */
	translations?: TranslationSummary[];
	/** Callback to create a translation for a locale */
	onTranslate?: (locale: string) => void;
	/** Plugin block types available for insertion in Portable Text fields */
	pluginBlocks?: PluginBlockDef[];
	/** Whether this collection has SEO fields enabled */
	hasSeo?: boolean;
	/** Callback when SEO fields change */
	onSeoChange?: (seo: ContentSeoInput) => void;
	/** Admin manifest for resolving plugin field widgets */
	manifest?: import("../lib/api/client.js").AdminManifest | null;
}

/**
 * Content editor with dynamic field rendering
 */
export function ContentEditor({
	collection,
	collectionLabel,
	item,
	fields,
	isNew,
	entryLocale,
	isSaving,
	isSaveFeedbackActive,
	onSave,
	onAutosave,
	isAutosaving,
	isAutosaveFeedbackActive,
	autosaveCompletionToken,
	onPublish,
	onUnpublish,
	onDiscardDraft,
	onSchedule,
	onUnschedule,
	isScheduling,
	supportsDrafts = false,
	supportsRevisions = false,
	supportsPreview = false,
	currentUser,
	users,
	onAuthorChange,
	availableBylines,
	availableBylinesLoaded,
	selectedBylines,
	onBylinesChange,
	onQuickCreateByline,
	onQuickEditByline,
	onDelete,
	isDeleting,
	i18n,
	translations,
	onTranslate,
	pluginBlocks,
	hasSeo = false,
	onSeoChange,
	manifest,
}: ContentEditorProps) {
	const { t } = useLingui();
	const { locale: uiLocale } = useLocale();
	// Kumo Sidebar's `side` is physical, not logical.
	const panelSide = getLocaleDir(uiLocale) === "rtl" ? "left" : "right";
	// Mirrors the Sidebar's mobileBreakpoint; `contained` flips with it.
	const [isBelowLg, setIsBelowLg] = React.useState(
		() => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
	);
	React.useEffect(() => {
		const mq = window.matchMedia("(max-width: 1023px)");
		const onChange = () => setIsBelowLg(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	const [formData, setFormData] = React.useState<Record<string, unknown>>(item?.data || {});
	const [slug, setSlug] = React.useState(item?.slug || "");
	const [slugTouched, setSlugTouched] = React.useState(!!item?.slug);
	const [status, setStatus] = React.useState(item?.status || "draft");
	const [internalBylines, setInternalBylines] = React.useState<BylineCreditInput[]>(
		item?.bylines?.map((entry) => ({ bylineId: entry.byline.id, roleLabel: entry.roleLabel })) ??
			[],
	);
	// Gates whether `bylines` is included in the save payload. Untouched
	// edits must not ship `[]` — strict per-locale hydration can return
	// empty for entries with credits at other locales, and sending `[]`
	// would wipe them.
	const [bylinesTouched, setBylinesTouched] = React.useState(false);

	// Track portableText editor for document outline. Only the "content"
	// field wires its editor into this slot (see onEditorReady below).
	const [portableTextEditor, setPortableTextEditor] = React.useState<Editor | null>(null);

	// Block sidebar state – when a block (e.g. image) requests sidebar space, this holds
	// the panel data. When non-null the sidebar shows the block panel instead of the
	// default content settings sections.
	const [blockSidebarPanel, setBlockSidebarPanel] = React.useState<BlockSidebarPanel | null>(null);

	const handleBlockSidebarOpen = React.useCallback((panel: BlockSidebarPanel) => {
		setBlockSidebarPanel(panel);
	}, []);

	const handleBlockSidebarClose = React.useCallback(() => {
		setBlockSidebarPanel((previous) => {
			previous?.onClose();
			return null;
		});
	}, []);

	const handleBlockSidebarDelete = React.useCallback(() => {
		blockSidebarPanel?.onDelete();
		setBlockSidebarPanel(null);
	}, [blockSidebarPanel]);

	const handleSeoChange = React.useCallback(
		(seo: ContentSeoInput) => {
			onSeoChange?.(seo);
		},
		[onSeoChange],
	);

	// Track the last saved state to determine if dirty
	const [lastSavedData, setLastSavedData] = React.useState<string>(
		serializeEditorState({
			data: item?.data || {},
			slug: item?.slug || "",
			bylines:
				item?.bylines?.map((entry) => ({
					bylineId: entry.byline.id,
					roleLabel: entry.roleLabel,
				})) ?? [],
		}),
	);
	const pendingAutosaveStateRef = React.useRef<string | null>(null);

	// Synchronously reset form state when the underlying item changes (e.g. a
	// translation switch where TanStack Router keeps ContentEditor mounted but
	// swaps `item` for a different id). The post-render useEffect below also
	// syncs item -> formData, but it runs *after* the first render with the new
	// item, leaving children (notably PortableTextEditor, which freezes its
	// initial content on mount) one render behind. This is the React-recommended
	// "store info from previous renders" idiom -- see
	// https://react.dev/reference/react/useState#storing-information-from-previous-renders
	//
	// We also reset lastSavedData here (not just in the post-render effect) so
	// that isDirty stays false through the switch -- otherwise SaveButton would
	// briefly flip from "Saved" -> "Save" -> "Saved" within a single tick.
	const [previousItemId, setPreviousItemId] = React.useState<string | null>(item?.id ?? null);
	if (item && item.id !== previousItemId) {
		setPreviousItemId(item.id);
		setFormData(item.data);
		setSlug(item.slug || "");
		setSlugTouched(!!item.slug);
		setStatus(item.status);
		const nextBylines =
			item.bylines?.map((entry) => ({ bylineId: entry.byline.id, roleLabel: entry.roleLabel })) ??
			[];
		setInternalBylines(nextBylines);
		setLastSavedData(
			serializeEditorState({
				data: item.data,
				slug: item.slug || "",
				bylines: nextBylines,
			}),
		);
		pendingAutosaveStateRef.current = null;
		setBylinesTouched(false);
	}

	// Update form and last saved state when item changes (e.g., after save or restore)
	// Stringify the data for comparison since objects are compared by reference
	const itemDataString = React.useMemo(() => (item ? JSON.stringify(item.data) : ""), [item?.data]);
	React.useEffect(() => {
		if (item) {
			setFormData(item.data);
			setSlug(item.slug || "");
			setSlugTouched(!!item.slug);
			setStatus(item.status);
			setInternalBylines(
				item.bylines?.map((entry) => ({ bylineId: entry.byline.id, roleLabel: entry.roleLabel })) ??
					[],
			);
			setLastSavedData(
				serializeEditorState({
					data: item.data,
					slug: item.slug || "",
					bylines:
						item.bylines?.map((entry) => ({
							bylineId: entry.byline.id,
							roleLabel: entry.roleLabel,
						})) ?? [],
				}),
			);
			pendingAutosaveStateRef.current = null;
			setBylinesTouched(false);
		}
	}, [item?.updatedAt, itemDataString, item?.slug, item?.status]);

	const activeBylines = isNew ? (selectedBylines ?? []) : internalBylines;

	const handleBylinesChange = React.useCallback(
		(next: BylineCreditInput[]) => {
			setBylinesTouched(true);
			if (isNew) {
				onBylinesChange?.(next);
				return;
			}
			setInternalBylines(next);
			onBylinesChange?.(next);
		},
		[isNew, onBylinesChange],
	);

	// Check if form has unsaved changes
	const currentData = React.useMemo(
		() =>
			serializeEditorState({
				data: formData,
				slug,
				bylines: activeBylines,
			}),
		[formData, slug, activeBylines],
	);
	const isDirty = isNew || currentData !== lastSavedData;
	const saveFeedbackActive = isSaveFeedbackActive ?? isSaving;
	const autosaveFeedbackActive = isAutosaveFeedbackActive ?? isAutosaving;
	const isContentOperationPending = Boolean(isSaving);

	// Autosave with debounce
	// Track pending autosave to cancel on manual save
	const autosaveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const formDataRef = React.useRef(formData);
	formDataRef.current = formData;
	const slugRef = React.useRef(slug);
	slugRef.current = slug;

	React.useEffect(() => {
		if (!autosaveCompletionToken || !pendingAutosaveStateRef.current) {
			return;
		}

		setLastSavedData(pendingAutosaveStateRef.current);
		pendingAutosaveStateRef.current = null;
	}, [autosaveCompletionToken]);

	const hasInvalidUrls = React.useCallback(
		(data: Record<string, unknown>) => {
			for (const [name, field] of Object.entries(fields)) {
				if (field.kind === "url") {
					const val = typeof data[name] === "string" ? data[name].trim() : "";
					if (val && !isValidUrl(val)) return true;
				}
			}
			return false;
		},
		[fields],
	);

	React.useEffect(() => {
		// Don't autosave for new items (no ID yet) or if autosave isn't configured
		if (isNew || !onAutosave || !item?.id) {
			return;
		}

		// Don't autosave if not dirty or already saving
		if (!isDirty || isSaving || isAutosaving) {
			return;
		}

		// Clear any pending autosave
		if (autosaveTimeoutRef.current) {
			clearTimeout(autosaveTimeoutRef.current);
		}

		// Schedule autosave
		autosaveTimeoutRef.current = setTimeout(() => {
			if (hasInvalidUrls(formDataRef.current)) return;
			const payload: {
				data: Record<string, unknown>;
				slug?: string;
				bylines?: BylineCreditInput[];
			} = {
				data: formDataRef.current,
				slug: slugRef.current || undefined,
			};
			if (bylinesTouched) payload.bylines = activeBylines;
			pendingAutosaveStateRef.current = serializeEditorState({
				data: payload.data,
				slug: payload.slug || "",
				bylines: activeBylines,
			});
			onAutosave(payload);
		}, AUTOSAVE_DELAY);

		return () => {
			if (autosaveTimeoutRef.current) {
				clearTimeout(autosaveTimeoutRef.current);
			}
		};
	}, [
		currentData,
		isNew,
		onAutosave,
		item?.id,
		isDirty,
		isSaving,
		isAutosaving,
		activeBylines,
		bylinesTouched,
		hasInvalidUrls,
	]);

	// Cancel pending autosave on manual save
	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (hasInvalidUrls(formData)) return;
		// Cancel pending autosave
		if (autosaveTimeoutRef.current) {
			clearTimeout(autosaveTimeoutRef.current);
			autosaveTimeoutRef.current = null;
		}
		const payload: {
			data: Record<string, unknown>;
			slug?: string;
			bylines?: BylineCreditInput[];
		} = {
			data: formData,
			slug: slug || undefined,
		};
		if (isNew || bylinesTouched) payload.bylines = activeBylines;
		onSave?.(payload);
	};

	// Preview URL state
	const [isLoadingPreview, setIsLoadingPreview] = React.useState(false);

	const urlPattern = manifest?.collections[collection]?.urlPattern;

	const handlePreview = async () => {
		if (!item?.id) return;

		setIsLoadingPreview(true);
		try {
			const result = await getPreviewUrl(collection, item.id);
			if (result?.url) {
				window.open(result.url, "_blank", "noopener,noreferrer");
			} else {
				window.open(
					contentUrl(collection, slug || item.id, urlPattern),
					"_blank",
					"noopener,noreferrer",
				);
			}
		} catch {
			window.open(
				contentUrl(collection, slug || item?.id || "", urlPattern),
				"_blank",
				"noopener,noreferrer",
			);
		} finally {
			setIsLoadingPreview(false);
		}
	};

	const handleFieldChange = React.useCallback(
		(name: string, value: unknown) => {
			setFormData((prev) => ({ ...prev, [name]: value }));
			if (name === "title" && !slugTouched && typeof value === "string" && value) {
				setSlug(slugify(value));
			}
		},
		[slugTouched],
	);

	const handleSlugChange = React.useCallback((value: string) => {
		setSlug(value);
		setSlugTouched(true);
	}, []);

	const isPublished = status === "published";

	// Draft revision status (only meaningful when supportsDrafts is on)
	const draftStatus = item ? getDraftStatus(item) : "unpublished";
	const hasPendingChanges = draftStatus === "published_with_changes";
	const isLive = draftStatus === "published" || draftStatus === "published_with_changes";
	const liveViewUrl = isLive && item?.slug ? contentUrl(collection, item.slug, urlPattern) : null;

	// Scheduling — keyed off scheduledAt rather than status, since published
	// posts can now have a pending schedule without changing status.
	const hasSchedule = Boolean(item?.scheduledAt);
	const canSchedule =
		!isNew && !hasSchedule && Boolean(onSchedule) && (!isPublished || hasPendingChanges);

	// Distraction-free mode state
	const [isDistractionFree, setIsDistractionFree] = React.useState(false);

	// Escape exits distraction-free mode
	React.useEffect(() => {
		if (!isDistractionFree) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setIsDistractionFree(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [isDistractionFree]);

	return (
		<form
			onSubmit={handleSubmit}
			className={cn(
				"transition-all duration-300",
				isDistractionFree
					? "space-y-6 fixed inset-0 z-50 bg-kumo-base p-8 overflow-auto"
					: "flex h-full bg-kumo-base",
			)}
		>
			{/* Wraps the whole layout so the strip's Settings button and the
			    block-panel sync can reach the sidebar context. Below lg Kumo
			    renders the panel as an inline (not portaled) sheet. */}
			<Sidebar.Provider
				contained={!isBelowLg}
				defaultOpen
				side={panelSide}
				collapsible="offcanvas"
				mobileBreakpoint={1024}
				className={cn(!isDistractionFree && "h-full min-h-0")}
				style={
					{
						"--sidebar-width": isBelowLg ? "20rem" : "23rem",
					} as React.CSSProperties
				}
			>
				<div className={cn(isDistractionFree ? "w-full" : "flex-1 min-w-0 overflow-y-auto p-6")}>
					{/* In distraction-free mode the header is a hover-revealed overlay. */}
					<div
						className={cn(
							"flex flex-wrap items-center justify-between gap-y-2",
							isDistractionFree
								? "opacity-0 hover:opacity-100 transition-opacity duration-200 fixed top-0 start-0 end-0 bg-kumo-base/95 backdrop-blur p-4 z-10"
								: cn(
										"mx-auto mb-6 max-w-3xl",
										isBelowLg && "sticky top-0 z-20 bg-kumo-base/95 py-3 backdrop-blur",
									),
						)}
					>
						<div className="flex items-center gap-4">
							{!isDistractionFree && (
								<RouterLinkButton
									to="/content/$collection"
									params={{ collection }}
									search={{ locale: undefined }}
									aria-label={t`Back to ${collectionLabel} list`}
									variant="ghost"
									shape="square"
									icon={<ArrowPrev />}
								/>
							)}
							{isDistractionFree && (
								<Button
									variant="ghost"
									shape="square"
									onClick={() => setIsDistractionFree(false)}
									aria-label={t`Exit distraction-free mode`}
								>
									<ArrowsInSimple className="h-5 w-5" aria-hidden="true" />
								</Button>
							)}
							<h1 className="text-2xl font-bold">
								{isNew ? t`New ${collectionLabel}` : t`Edit ${collectionLabel}`}
							</h1>
							{i18n && item?.locale && (
								<Badge variant="outline" className="uppercase text-xs">
									{item.locale}
								</Badge>
							)}
						</div>
						<div className="flex items-center gap-2">
							{!isDistractionFree ? (
								// Below lg, actions move here from the (hidden) panel.
								<>
									{isBelowLg && (
										<div className="flex flex-wrap items-center justify-end gap-2">
											{!isNew && supportsPreview && (
												<PreviewButton
													hasPendingChanges={hasPendingChanges}
													isLoadingPreview={isLoadingPreview}
													onPreview={handlePreview}
												/>
											)}
											<SaveButton
												type="submit"
												isDirty={isDirty}
												isSaving={Boolean(saveFeedbackActive || autosaveFeedbackActive)}
												disabled={isContentOperationPending}
											/>
											{liveViewUrl && (
												<LinkButton
													href={liveViewUrl}
													external
													variant="outline"
													icon={<ArrowSquareOut />}
												>
													{t`Live View`}
												</LinkButton>
											)}
											<PublishActions
												isNew={isNew}
												isLive={isLive}
												hasPendingChanges={hasPendingChanges}
												onPublish={onPublish}
												onUnpublish={onUnpublish}
											/>
											<MobileSettingsButton />
										</div>
									)}
									<Button
										variant="ghost"
										shape="square"
										type="button"
										onClick={() => setIsDistractionFree(true)}
										aria-label={t`Enter distraction-free mode`}
										title={t`Distraction-free mode (⌘⇧\\)`}
									>
										<ArrowsOutSimple className="h-4 w-4" aria-hidden="true" />
									</Button>
								</>
							) : (
								// Distraction-free: this overlay is the only save/exit surface.
								<>
									{!isNew && supportsPreview && (
										<PreviewButton
											hasPendingChanges={hasPendingChanges}
											isLoadingPreview={isLoadingPreview}
											onPreview={handlePreview}
										/>
									)}
									<SaveButton
										type="submit"
										isDirty={isDirty}
										isSaving={Boolean(saveFeedbackActive || autosaveFeedbackActive)}
										disabled={isContentOperationPending}
									/>
									{liveViewUrl && (
										<LinkButton
											href={liveViewUrl}
											external
											variant="outline"
											icon={<ArrowSquareOut />}
										>
											{t`Live View`}
										</LinkButton>
									)}
									{!isNew && (
										<>
											{supportsDrafts && hasPendingChanges && onDiscardDraft && (
												<DiscardDraftDialog onDiscard={onDiscardDraft} triggerVariant="outline" />
											)}
											<PublishActions
												isLive={isLive}
												hasPendingChanges={hasPendingChanges}
												onPublish={onPublish}
												onUnpublish={onUnpublish}
											/>
										</>
									)}
								</>
							)}
						</div>
					</div>

					<div
						className={cn(
							isDistractionFree ? "max-w-4xl mx-auto pt-16" : "mx-auto max-w-3xl space-y-6",
						)}
					>
						<div className="space-y-4">
							{Object.entries(fields).map(([name, field]) => {
								// Key by item id so all field editors remount cleanly when the
								// underlying content item changes (e.g. switching translations).
								// PortableTextEditor in particular freezes its initial content on
								// mount; without this key, navigating between translations leaves
								// the previous locale's body in the editor and silently overwrites
								// the new translation on the next edit.
								const fieldKey = `${name}:${item?.id ?? "new"}`;
								const fieldEl = (
									<FieldRenderer
										key={fieldKey}
										name={name}
										field={field}
										value={formData[name]}
										onChange={handleFieldChange}
										onEditorReady={
											field.kind === "portableText" && name === "content"
												? setPortableTextEditor
												: undefined
										}
										minimal={isDistractionFree}
										pluginBlocks={pluginBlocks}
										onBlockSidebarOpen={
											field.kind === "portableText" ? handleBlockSidebarOpen : undefined
										}
										onBlockSidebarClose={
											field.kind === "portableText" ? handleBlockSidebarClose : undefined
										}
										manifest={manifest}
									/>
								);
								return fieldEl;
							})}
						</div>
					</div>
				</div>

				{/* Hidden (not unmounted) in distraction-free mode so panel-local
			    state survives the round trip; `hidden` on the pane's own layout
			    element leaves no gap. */}
				<Sidebar aria-label={t`Settings`} className={cn(isDistractionFree && "hidden")}>
					{/* The action bar absorbs the high-frequency props (isDirty,
					    isSaving, isAutosaving) so they never reach the memoized panel. */}
					{!isBelowLg && (
						<SettingsActionBar
							isNew={isNew}
							isDirty={isDirty}
							isSaving={Boolean(saveFeedbackActive)}
							isAutosaving={autosaveFeedbackActive}
							saveDisabled={isContentOperationPending}
							isLive={isLive}
							hasPendingChanges={hasPendingChanges}
							liveViewUrl={liveViewUrl}
							supportsPreview={supportsPreview}
							isLoadingPreview={isLoadingPreview}
							onPreview={handlePreview}
							onPublish={onPublish}
							onUnpublish={onUnpublish}
							announceSaveStatus={!isDistractionFree}
						/>
					)}
					<div
						className="flex-1 overflow-y-auto overflow-x-hidden"
						style={isBelowLg ? { paddingTop: ADMIN_HEADER_HEIGHT_PX } : undefined}
					>
						{isBelowLg && (
							<div className="flex justify-end px-4 pt-3">
								<MobileSettingsCloseButton />
							</div>
						)}
						<ContentSettingsPanel
							collection={collection}
							item={item}
							isNew={isNew}
							entryLocale={entryLocale}
							slug={slug}
							onSlugChange={handleSlugChange}
							status={status}
							supportsDrafts={supportsDrafts}
							isLive={isLive}
							hasPendingChanges={hasPendingChanges}
							hasSchedule={hasSchedule}
							supportsRevisions={supportsRevisions}
							canSchedule={canSchedule}
							onSchedule={onSchedule}
							onUnschedule={onUnschedule}
							isScheduling={isScheduling}
							onDiscardDraft={onDiscardDraft}
							onDelete={onDelete}
							isDeleting={isDeleting}
							currentUser={currentUser}
							users={users}
							onAuthorChange={onAuthorChange}
							activeBylines={activeBylines}
							availableBylines={availableBylines}
							availableBylinesLoaded={availableBylinesLoaded}
							onBylinesChange={handleBylinesChange}
							onQuickCreateByline={onQuickCreateByline}
							onQuickEditByline={onQuickEditByline}
							i18n={i18n}
							translations={translations}
							onTranslate={onTranslate}
							hasSeo={hasSeo}
							onSeoChange={onSeoChange ? handleSeoChange : undefined}
							portableTextEditor={portableTextEditor}
							blockSidebarPanel={blockSidebarPanel}
							onBlockSidebarClose={handleBlockSidebarClose}
							onBlockSidebarDelete={handleBlockSidebarDelete}
						/>
					</div>
				</Sidebar>

				{/* Below lg, opening a block detail panel must open the sheet.
				    Suspended in distraction-free mode: the nav is hidden there but
				    Kumo's separate backdrop would still scrim the whole screen. */}
				<MobileBlockSidebarSync active={!!blockSidebarPanel} suspended={isDistractionFree} />
				<MobileSidebarPortalGuard />
			</Sidebar.Provider>
		</form>
	);
}

/**
 * Opens the settings sheet when a portable-text block requests sidebar
 * space below the mobile breakpoint, and restores the sheet's prior
 * open/closed state when the block panel closes. Renders nothing.
 */
function MobileBlockSidebarSync({ active, suspended }: { active: boolean; suspended?: boolean }) {
	const { isMobile, openMobile, setOpenMobile } = useSidebar();
	const prevActiveRef = React.useRef(active);
	const prevIsMobileRef = React.useRef(isMobile);
	const prevSuspendedRef = React.useRef(suspended);
	const priorOpenRef = React.useRef<boolean | null>(null);

	React.useEffect(() => {
		const becameActive = active && !prevActiveRef.current;
		const becameInactive = !active && prevActiveRef.current;
		const becameMobileWithActivePanel = active && isMobile && !prevIsMobileRef.current;
		const becameUnsuspendedWithActivePanel = active && !suspended && prevSuspendedRef.current;
		prevActiveRef.current = active;
		prevIsMobileRef.current = isMobile;
		prevSuspendedRef.current = suspended;

		if (!isMobile) {
			priorOpenRef.current = null;
			if (openMobile) setOpenMobile(false);
			return;
		}

		// While suspended (distraction-free), keep the sheet closed: its nav is
		// display:none but the backdrop sibling would still scrim the screen.
		if (suspended) {
			priorOpenRef.current = null;
			if (openMobile) setOpenMobile(false);
			return;
		}

		if (becameInactive) {
			setOpenMobile(priorOpenRef.current ?? false);
			priorOpenRef.current = null;
			return;
		}

		if (becameActive || becameMobileWithActivePanel || becameUnsuspendedWithActivePanel) {
			priorOpenRef.current = openMobile;
			setOpenMobile(true);
		}
	}, [active, isMobile, openMobile, setOpenMobile, suspended]);

	return null;
}

/**
 * Kumo closes its mobile sheet whenever focus leaves the sheet DOM. Keep it
 * open when focus moves into a portaled control, and keep those overlays above
 * the sheet's z-50 layer.
 */
function MobileSidebarPortalGuard() {
	const { isMobile, openMobile, setOpenMobile } = useSidebar();

	React.useEffect(() => {
		if (!isMobile || !openMobile) return;
		const nestedOverlaySelector =
			'[role="dialog"], [role="listbox"], [role="menu"], .kumo-tooltip-popup';
		const keepSheetOpen = () => queueMicrotask(() => setOpenMobile(true));
		const promotePortal = (element: Element) => {
			const overlay =
				element.closest(nestedOverlaySelector) ?? element.querySelector(nestedOverlaySelector);
			const portal = overlay?.closest<HTMLElement>("[data-base-ui-portal]");
			if (!portal) return;
			portal.style.position = "relative";
			portal.style.zIndex = "60";
		};

		const handleFocusOut = (event: FocusEvent) => {
			const source = event.target;
			const destination = event.relatedTarget;
			if (!(source instanceof Element) || !(destination instanceof Element)) return;

			const sheet = source.closest('nav[data-sidebar="sidebar"][data-mobile="true"]');
			if (!sheet || sheet.contains(destination)) return;
			if (!destination.closest(nestedOverlaySelector)) return;

			promotePortal(destination);
			keepSheetOpen();
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			const target = event.target;
			if (!(target instanceof Element) || !target.closest(nestedOverlaySelector)) return;
			keepSheetOpen();
		};

		document.addEventListener("focusout", handleFocusOut, true);
		document.addEventListener("keydown", handleKeyDown, true);
		const portalObserver = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node instanceof Element) promotePortal(node);
				}
			}
		});
		portalObserver.observe(document.body, { childList: true, subtree: true });
		document
			.querySelectorAll<HTMLElement>("[data-base-ui-portal]")
			.forEach((portal) => promotePortal(portal));
		return () => {
			document.removeEventListener("focusout", handleFocusOut, true);
			document.removeEventListener("keydown", handleKeyDown, true);
			portalObserver.disconnect();
		};
	}, [isMobile, openMobile, setOpenMobile]);

	return null;
}

/**
 * "Settings" trigger for the mobile sheet. Lives in the editor strip,
 * which sits inside the Sidebar.Provider, so it can reach the context.
 */
function MobileSettingsButton() {
	const { t } = useLingui();
	const { toggleSidebar } = useSidebar();
	return (
		<Button type="button" variant="outline" icon={<Faders />} onClick={toggleSidebar}>
			{t`Settings`}
		</Button>
	);
}

function MobileSettingsCloseButton() {
	const { t } = useLingui();
	const { setOpenMobile } = useSidebar();
	return (
		<Button
			type="button"
			variant="ghost"
			shape="square"
			icon={<X />}
			aria-label={t`Close settings`}
			onClick={() => setOpenMobile(false)}
		/>
	);
}

interface FieldRendererProps {
	name: string;
	field: FieldDescriptor;
	value: unknown;
	onChange: (name: string, value: unknown) => void;
	/** Callback when a portableText editor is ready.
	 * Called with the editor on mount, and with `null` on unmount. */
	onEditorReady?: (editor: Editor | null) => void;
	/** Minimal chrome - hides toolbar, fades labels, removes borders (distraction-free mode) */
	minimal?: boolean;
	/** Plugin block types available for insertion in Portable Text fields */
	pluginBlocks?: PluginBlockDef[];
	/** Callback when a block node requests sidebar space */
	onBlockSidebarOpen?: (panel: BlockSidebarPanel) => void;
	/** Callback when a block node closes its sidebar */
	onBlockSidebarClose?: () => void;
	/** Admin manifest for resolving sandboxed field widget elements */
	manifest?: import("../lib/api/client.js").AdminManifest | null;
}

/**
 * Render field based on type
 */
function FieldRenderer({
	name,
	field,
	value,
	onChange,
	onEditorReady,
	minimal,
	pluginBlocks,
	onBlockSidebarOpen,
	onBlockSidebarClose,
	manifest,
}: FieldRendererProps) {
	const { t } = useLingui();
	const pluginAdmins = usePluginAdmins();
	const label = field.label || name.charAt(0).toUpperCase() + name.slice(1);
	const id = `field-${name}`;
	const labelClass = minimal ? "text-kumo-subtle/50 text-xs font-normal" : undefined;

	const handleChange = React.useCallback((v: unknown) => onChange(name, v), [onChange, name]);

	// Check for plugin field widget override
	if (field.widget) {
		const sepIdx = field.widget.indexOf(":");
		if (sepIdx <= 0) {
			console.warn(
				`[emdash] Field "${name}" has widget "${field.widget}" but it should use the format "pluginId:widgetName". Falling back to default editor.`,
			);
		}
		if (sepIdx > 0) {
			const pluginId = field.widget.slice(0, sepIdx);
			const widgetName = field.widget.slice(sepIdx + 1);
			// Trusted plugin: React component
			const PluginField = pluginAdmins[pluginId]?.fields?.[widgetName] as
				| React.ComponentType<{
						value: unknown;
						onChange: (value: unknown) => void;
						label: string;
						id: string;
						required?: boolean;
						options?: Array<{ value: string; label: string }> | Record<string, unknown>;
						minimal?: boolean;
				  }>
				| undefined;
			if (typeof PluginField === "function") {
				return (
					<PluginFieldErrorBoundary fieldKind={field.kind}>
						<PluginField
							value={value}
							onChange={handleChange}
							label={label}
							id={id}
							required={field.required}
							options={field.options}
							minimal={minimal}
						/>
					</PluginFieldErrorBoundary>
				);
			}
			// Sandboxed plugin: Block Kit elements from manifest
			if (manifest) {
				const pluginManifest = manifest.plugins[pluginId];
				const widgetDef = pluginManifest?.fieldWidgets?.find((w) => w.name === widgetName);
				if (widgetDef?.elements && widgetDef.elements.length > 0) {
					return (
						<PluginFieldErrorBoundary fieldKind={field.kind}>
							<BlockKitFieldWidget
								label={label}
								elements={widgetDef.elements}
								value={value}
								onChange={handleChange}
							/>
						</PluginFieldErrorBoundary>
					);
				}
			}
			// Widget declared but plugin not found/active -- fall through to default
		}
	}

	switch (field.kind) {
		case "string":
			return (
				<Input
					label={<span className={labelClass}>{label}</span>}
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => handleChange(e.target.value)}
					required={field.required}
					dir="auto"
					className={
						minimal
							? "border-0 bg-transparent px-0 text-lg font-medium focus-visible:ring-0 focus-visible:ring-offset-0"
							: undefined
					}
				/>
			);

		case "number":
			return (
				<Input
					label={<span className={labelClass}>{label}</span>}
					id={id}
					type="number"
					value={typeof value === "number" ? value : ""}
					onChange={(e) => handleChange(Number(e.target.value))}
					required={field.required}
				/>
			);

		case "boolean":
			return (
				<Switch id={id} label={label} checked={Boolean(value)} onCheckedChange={handleChange} />
			);

		case "portableText": {
			const labelId = `${id}-label`;
			return (
				<div id={id}>
					{!minimal && (
						<span
							id={labelId}
							className={cn("text-sm font-medium leading-none text-kumo-default", labelClass)}
						>
							{label}
						</span>
					)}
					<PortableTextEditor
						value={Array.isArray(value) ? value : []}
						onChange={handleChange}
						placeholder={t`Start writing, or type '/' for commands`}
						aria-labelledby={labelId}
						pluginBlocks={pluginBlocks}
						onEditorReady={onEditorReady}
						minimal={minimal}
						onBlockSidebarOpen={onBlockSidebarOpen}
						onBlockSidebarClose={onBlockSidebarClose}
					/>
				</div>
			);
		}

		case "richText":
			// For richText (markdown), use InputArea
			return (
				<InputArea
					label={label}
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => handleChange(e.target.value)}
					rows={10}
					dir="auto"
					placeholder={t`Enter markdown content...`}
				/>
			);

		case "select": {
			const selectOptions = Array.isArray(field.options) ? field.options : [];
			const selectItems: Record<string, string> = {};
			for (const opt of selectOptions) {
				selectItems[opt.value] = opt.label;
			}
			return (
				<Select
					id={id}
					label={label}
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => handleChange(v ?? "")}
					items={selectItems}
				>
					{selectOptions.map((opt) => (
						<Select.Option key={opt.value} value={opt.value}>
							{opt.label}
						</Select.Option>
					))}
				</Select>
			);
		}

		case "multiSelect": {
			const multiSelectOptions = Array.isArray(field.options) ? field.options : [];
			const selected: string[] = Array.isArray(value) ? (value as string[]) : [];
			return (
				<fieldset>
					<Label className={labelClass}>{label}</Label>
					<div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
						{multiSelectOptions.map((opt) => {
							const isChecked = selected.includes(opt.value);
							return (
								<Checkbox
									key={opt.value}
									label={opt.label}
									checked={isChecked}
									onCheckedChange={(checked) => {
										const next = checked
											? [...selected, opt.value]
											: selected.filter((v) => v !== opt.value);
										handleChange(next);
									}}
								/>
							);
						})}
					</div>
				</fieldset>
			);
		}

		case "datetime":
			return (
				<Input
					label={label}
					id={id}
					type="datetime-local"
					value={toDatetimeLocalInputValue(value)}
					onChange={(e) => handleChange(fromDatetimeLocalInputValue(e.target.value))}
					required={field.required}
				/>
			);

		case "image": {
			// value is either an ImageFieldValue object, a legacy string URL, or undefined
			const imageValue =
				value != null && typeof value === "object" ? (value as ImageFieldValue) : undefined;
			return (
				<ImageFieldRenderer
					id={id}
					label={label}
					description={
						name === "featured_image"
							? t`Used as the main visual for this post on listing pages and at the top of the post`
							: undefined
					}
					value={imageValue}
					onChange={handleChange}
					required={field.required}
					allowedMimeTypes={
						Array.isArray(field.validation?.allowedMimeTypes)
							? (field.validation.allowedMimeTypes as string[])
							: undefined
					}
					fieldId={field.id}
				/>
			);
		}

		case "file": {
			// value is either a FileFieldValue object or undefined.
			// The file field type was unusable before this PR (rendered as a text input
			// that produced raw strings nobody could meaningfully save), so there is no
			// "legacy string" data to preserve here.
			const fileValue =
				value != null && typeof value === "object" ? (value as FileFieldValue) : undefined;
			return (
				<FileFieldRenderer
					id={id}
					label={label}
					value={fileValue}
					onChange={handleChange}
					required={field.required}
					allowedMimeTypes={
						Array.isArray(field.validation?.allowedMimeTypes)
							? (field.validation.allowedMimeTypes as string[])
							: undefined
					}
					fieldId={field.id}
				/>
			);
		}

		case "repeater": {
			const validation = field.validation;
			const subFields = (validation?.subFields ?? []) as Array<{
				slug: string;
				type: string;
				label: string;
				required?: boolean;
				options?: string[];
			}>;
			return (
				<RepeaterField
					label={label}
					id={id}
					value={value}
					onChange={handleChange}
					required={field.required}
					subFields={subFields}
					minItems={typeof validation?.minItems === "number" ? validation.minItems : undefined}
					maxItems={typeof validation?.maxItems === "number" ? validation.maxItems : undefined}
				/>
			);
		}

		case "json": {
			const jsonString =
				typeof value === "string" ? value : value != null ? JSON.stringify(value, null, 2) : "";
			return (
				<JsonFieldEditor
					label={label}
					id={id}
					value={jsonString}
					onChange={handleChange}
					required={field.required}
				/>
			);
		}

		case "url":
			return (
				<UrlFieldEditor
					label={label}
					labelClass={labelClass}
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={handleChange}
					required={field.required}
					placeholder="https://"
				/>
			);

		default:
			// Default to text input
			return (
				<Input
					label={label}
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => handleChange(e.target.value)}
					required={field.required}
					dir="auto"
				/>
			);
	}
}

const URL_PROTOCOL_PATTERN = /^https?:\/\//;

function isValidUrl(val: string): boolean {
	if (!URL_PROTOCOL_PATTERN.test(val)) return false;
	try {
		const url = new URL(val);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (url.hostname.includes("..")) return false;
		return url.hostname.includes(".") || url.hostname === "localhost";
	} catch {
		return false;
	}
}

/**
 * URL field editor with validation on blur
 */
function UrlFieldEditor({
	label,
	labelClass,
	id,
	value,
	onChange,
	required,
	placeholder,
}: {
	label: string;
	labelClass?: string;
	id: string;
	value: string;
	onChange: (value: unknown) => void;
	required?: boolean;
	placeholder?: string;
}) {
	const { t } = useLingui();
	const [error, setError] = React.useState<string | null>(null);

	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		const val = e.target.value.trim();
		if (!val) {
			setError(null);
			return;
		}
		if (!isValidUrl(val)) {
			setError(t`Enter a valid URL (e.g. https://example.com)`);
		} else {
			setError(null);
		}
	};

	return (
		<div>
			<Input
				label={<span className={labelClass}>{label}</span>}
				id={id}
				type="url"
				value={value}
				onChange={(e) => {
					if (error) setError(null);
					onChange(e.target.value);
				}}
				onBlur={handleBlur}
				required={required}
				placeholder={placeholder}
			/>
			{error && <p className="text-sm text-kumo-danger mt-1">{error}</p>}
		</div>
	);
}

/**
 * JSON field editor with syntax validation
 */
function JsonFieldEditor({
	label,
	id,
	value,
	onChange,
	required,
}: {
	label: string;
	id: string;
	value: string;
	onChange: (value: unknown) => void;
	required?: boolean;
}) {
	const { t } = useLingui();
	const [text, setText] = React.useState(value);
	const [error, setError] = React.useState<string | null>(null);

	// Sync from parent when value changes externally
	React.useEffect(() => {
		setText(value);
		setError(null);
	}, [value]);

	const handleChange = (newText: string) => {
		setText(newText);
		setError(null);
	};

	const handleBlur = () => {
		const trimmed = text.trim();
		if (trimmed === "") {
			setError(null);
			onChange(null);
			return;
		}
		try {
			const parsed = JSON.parse(trimmed);
			setError(null);
			onChange(parsed);
		} catch {
			setError(t`Invalid JSON`);
		}
	};

	return (
		<div>
			<InputArea
				label={label}
				id={id}
				value={text}
				onChange={(e) => handleChange(e.target.value)}
				onBlur={handleBlur}
				rows={8}
				placeholder="{}"
				required={required}
				className="font-mono text-sm"
			/>
			{error && <p className="text-sm text-kumo-danger mt-1">{error}</p>}
		</div>
	);
}

// ImageFieldRenderer (and its ImageFieldValue shape) moved to
// ./ImageFieldRenderer so repeater sub-fields can reuse the picker.

/**
 * File field value — matches the "file" shape validated by the Zod generator:
 * { id, provider?, src?, filename?, mimeType?, size?, meta? }
 */
interface FileFieldValue {
	id: string;
	/** Provider ID (e.g., "local", "s3") */
	provider?: string;
	/** Direct URL for non-local media */
	src?: string;
	filename?: string;
	mimeType?: string;
	size?: number;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
}

interface FileFieldRendererProps {
	id?: string;
	label: string;
	value: FileFieldValue | undefined;
	onChange: (value: FileFieldValue | null) => void;
	required?: boolean;
	allowedMimeTypes?: string[];
	fieldId?: string;
}

/**
 * File field with media picker
 *
 * Like ImageFieldRenderer but for arbitrary file types. Shows a mime-type-appropriate
 * icon, filename, and size instead of an image preview.
 */
function FileFieldRenderer({
	id,
	label,
	value,
	onChange,
	required,
	allowedMimeTypes,
	fieldId,
}: FileFieldRendererProps) {
	const { t } = useLingui();
	const [pickerOpen, setPickerOpen] = React.useState(false);

	// Normalize value to derive display info.
	// For local files, prefer meta.storageKey; fall back to value.src when it's an
	// internal media path; finally fall back to value.id so local files remain
	// clickable even when metadata is sparse. For external providers, use value.src
	// but only when it's an http(s) URL — a hostile provider plugin could otherwise
	// return a data: or javascript: URL that gets rendered as a clickable link.
	const normalized = React.useMemo(() => {
		if (!value) return null;
		const isLocal = !value.provider || value.provider === "local";
		const storageKey =
			typeof value.meta?.storageKey === "string" ? value.meta.storageKey : undefined;
		const localSrc =
			typeof value.src === "string" && value.src.startsWith("/_emdash/") ? value.src : undefined;
		// Storage keys come from server-controlled paths today, but the Zod schema
		// now lets clients write arbitrary `meta.storageKey` strings via the content
		// API. Encode before interpolating so attacker-shaped values can't escape
		// the path with `?` or `#`.
		const localUrl = isLocal
			? storageKey
				? `/_emdash/api/media/file/${encodeURIComponent(storageKey)}`
				: (localSrc ?? `/_emdash/api/media/file/${encodeURIComponent(value.id)}`)
			: undefined;
		const externalUrl = !isLocal && value.src && isSafeUrl(value.src) ? value.src : undefined;
		return {
			displayUrl: localUrl ?? externalUrl,
			filename: value.filename || t`Untitled file`,
			mimeType: value.mimeType || "",
			size: value.size,
		};
	}, [value, t]);

	const handleSelect = (item: MediaItem) => {
		const isLocalProvider = !item.provider || item.provider === "local";
		onChange({
			id: item.id,
			provider: item.provider || "local",
			src: isLocalProvider ? undefined : item.url,
			filename: item.filename,
			mimeType: item.mimeType,
			size: item.size,
			meta: isLocalProvider ? { ...item.meta, storageKey: item.storageKey } : item.meta,
		});
	};

	const handleRemove = () => {
		onChange(null);
	};

	const hasMime = !!normalized?.mimeType;
	const size = typeof normalized?.size === "number" ? normalized.size : undefined;
	const hasSize = size !== undefined;

	return (
		<div id={id}>
			<Label>{label}</Label>
			{normalized ? (
				<div className="mt-2 flex items-center gap-3 rounded-lg border p-3">
					<span className="text-3xl" aria-hidden="true">
						{getFileIcon(normalized.mimeType)}
					</span>
					<div className="flex-1 min-w-0">
						{normalized.displayUrl ? (
							<a
								href={normalized.displayUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sm font-medium truncate block hover:underline"
							>
								{normalized.filename}
							</a>
						) : (
							<p className="text-sm font-medium truncate">{normalized.filename}</p>
						)}
						{(hasMime || hasSize) && (
							<p className="text-xs text-kumo-subtle">
								{hasMime ? normalized.mimeType : null}
								{hasMime && hasSize ? " • " : null}
								{hasSize ? formatFileSize(size) : null}
							</p>
						)}
					</div>
					<div className="flex gap-1">
						<Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
							{t`Change`}
						</Button>
						<Button
							type="button"
							shape="square"
							variant="destructive"
							className="h-8 w-8"
							onClick={handleRemove}
							aria-label={t`Remove ${label}`}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					className="mt-2 w-full h-32 justify-center border-dashed"
					onClick={() => setPickerOpen(true)}
					aria-label={t`Select ${label}`}
				>
					<div className="flex flex-col items-center gap-2 text-kumo-subtle">
						<Paperclip className="h-8 w-8" />
						<span>{t`Select file`}</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilters={allowedMimeTypes ?? []}
				fieldId={fieldId}
				hideUrlInput
				mediaKind="file"
				title={t`Select ${label}`}
			/>
			{required && !normalized && (
				<p className="text-sm text-kumo-danger mt-1">{t`This field is required`}</p>
			)}
		</div>
	);
}
