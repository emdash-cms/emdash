import {
	Badge,
	Button,
	Dialog,
	Input,
	InputArea,
	Label,
	Loader,
	Select,
	Switch,
	buttonVariants,
} from "@cloudflare/kumo";
import {
	ArrowLeft,
	Check,
	Eye,
	Image as ImageIcon,
	MagnifyingGlass,
	X,
	Trash,
	ArrowsInSimple,
	ArrowsOutSimple,
	ArrowSquareOut,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
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
import { usePluginAdmins } from "../lib/plugin-context.js";
import { cn, slugify } from "../lib/utils";
import { BlockKitFieldWidget } from "./BlockKitFieldWidget.js";
import { DocumentOutline } from "./editor/DocumentOutline";
import { PluginFieldErrorBoundary } from "./PluginFieldErrorBoundary.js";

/** Autosave debounce delay in milliseconds */
const AUTOSAVE_DELAY = 2000;

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
import { ImageDetailPanel } from "./editor/ImageDetailPanel";
import type { ImageAttributes } from "./editor/ImageDetailPanel";
import { MediaPickerModal } from "./MediaPickerModal";
import {
	PortableTextEditor,
	type PluginBlockDef,
	type BlockSidebarPanel,
} from "./PortableTextEditor";
import { RevisionHistory } from "./RevisionHistory";
import { SaveButton } from "./SaveButton";
import { SeoImageField } from "./SeoImageField";
import { SeoPanel } from "./SeoPanel";
import { TaxonomySidebar } from "./TaxonomySidebar";

// Editor role level (40) from @emdash-cms/auth
const ROLE_EDITOR = 40;

export interface FieldDescriptor {
	kind: string;
	label?: string;
	required?: boolean;
	options?: Array<{ value: string; label: string }>;
	widget?: string;
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
	isSaving?: boolean;
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
	/** Last autosave timestamp (for UI indicator) */
	lastAutosaveAt?: Date | null;
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

/** Format scheduled date for display */
function formatScheduledDate(dateStr: string | null) {
	if (!dateStr) return null;
	const date = new Date(dateStr);
	return date.toLocaleString();
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
	isSaving,
	onSave,
	onAutosave,
	isAutosaving,
	lastAutosaveAt,
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
	const [formData, setFormData] = React.useState<Record<string, unknown>>(item?.data || {});
	const [slug, setSlug] = React.useState(item?.slug || "");
	const [slugTouched, setSlugTouched] = React.useState(!!item?.slug);
	const [status, setStatus] = React.useState(item?.status || "draft");
	const [internalBylines, setInternalBylines] = React.useState<BylineCreditInput[]>(
		item?.bylines?.map((entry) => ({ bylineId: entry.byline.id, roleLabel: entry.roleLabel })) ??
			[],
	);

	// Track portableText editor for document outline
	const [portableTextEditor, setPortableTextEditor] = React.useState<Editor | null>(null);

	// Block sidebar state – when a block (e.g. image) requests sidebar space, this holds
	// the panel data. When non-null the sidebar shows the block panel instead of the
	// default content settings sections.
	const [blockSidebarPanel, setBlockSidebarPanel] = React.useState<BlockSidebarPanel | null>(null);

	const handleBlockSidebarOpen = React.useCallback((panel: BlockSidebarPanel) => {
		setBlockSidebarPanel(panel);
	}, []);

	const handleBlockSidebarClose = React.useCallback(() => {
		setBlockSidebarPanel((prev) => {
			prev?.onClose();
			return null;
		});
	}, []);

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
		}
	}, [item?.updatedAt, itemDataString, item?.slug, item?.status]);

	const activeBylines = isNew ? (selectedBylines ?? []) : internalBylines;

	// Default author to current user when item has no author assigned
	React.useEffect(() => {
		if (currentUser && !item?.authorId && onAuthorChange) {
			onAuthorChange(currentUser.id);
		}
	}, [item?.id, currentUser?.id]);

	const handleBylinesChange = React.useCallback(
		(next: BylineCreditInput[]) => {
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

	// Autosave with debounce
	// Track pending autosave to cancel on manual save
	const autosaveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const formDataRef = React.useRef(formData);
	formDataRef.current = formData;
	const slugRef = React.useRef(slug);
	slugRef.current = slug;

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
			onAutosave({
				data: formDataRef.current,
				slug: slugRef.current || undefined,
				bylines: activeBylines,
			});
		}, AUTOSAVE_DELAY);

		return () => {
			if (autosaveTimeoutRef.current) {
				clearTimeout(autosaveTimeoutRef.current);
			}
		};
	}, [currentData, isNew, onAutosave, item?.id, isDirty, isSaving, isAutosaving, activeBylines]);

	// Cancel pending autosave on manual save
	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		// Cancel pending autosave
		if (autosaveTimeoutRef.current) {
			clearTimeout(autosaveTimeoutRef.current);
			autosaveTimeoutRef.current = null;
		}
		onSave?.({
			data: formData,
			slug: slug || undefined,
			bylines: activeBylines,
		});
	};

	// Preview URL state
	const [isLoadingPreview, setIsLoadingPreview] = React.useState(false);

	const handlePreview = async () => {
		if (!item?.id) return;

		const contentUrl = (s: string) => {
			const pattern = manifest?.collections[collection]?.urlPattern;
			return pattern ? pattern.replace("{slug}", s) : `/${collection}/${s}`;
		};

		setIsLoadingPreview(true);
		try {
			const result = await getPreviewUrl(collection, item.id);
			if (result?.url) {
				// Open preview in new tab
				window.open(result.url, "_blank", "noopener,noreferrer");
			} else {
				// Fallback to direct URL if preview not configured
				window.open(contentUrl(slug || item.id), "_blank", "noopener,noreferrer");
			}
		} catch {
			// Fallback to direct URL on error
			window.open(contentUrl(slug || item?.id || ""), "_blank", "noopener,noreferrer");
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

	const handleSlugChange = (value: string) => {
		setSlug(value);
		setSlugTouched(true);
	};

	const isPublished = status === "published";

	// Draft revision status (only meaningful when supportsDrafts is on)
	const draftStatus = item ? getDraftStatus(item) : "unpublished";
	const hasPendingChanges = draftStatus === "published_with_changes";
	const isLive = draftStatus === "published" || draftStatus === "published_with_changes";

	// Scheduling — keyed off scheduledAt rather than status, since published
	// posts can now have a pending schedule without changing status.
	const hasSchedule = Boolean(item?.scheduledAt);
	const canSchedule =
		!isNew && !hasSchedule && Boolean(onSchedule) && (!isPublished || hasPendingChanges);

	// Schedule datetime state
	const [scheduleDate, setScheduleDate] = React.useState<string>("");
	const [showScheduler, setShowScheduler] = React.useState(false);

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

	const handleScheduleSubmit = () => {
		if (scheduleDate && onSchedule) {
			// Convert local datetime to ISO string
			const date = new Date(scheduleDate);
			onSchedule(date.toISOString());
			setShowScheduler(false);
			setScheduleDate("");
		}
	};

	return (
		<form
			onSubmit={handleSubmit}
			className={cn(
				"space-y-6 transition-all duration-300",
				isDistractionFree && "fixed inset-0 z-50 bg-kumo-base p-8 overflow-auto",
			)}
		>
			{/* Header - show on hover in distraction-free mode */}
			<div
				className={cn(
					"flex flex-wrap items-center justify-between gap-y-2",
					isDistractionFree &&
						"opacity-0 hover:opacity-100 transition-opacity duration-200 fixed top-0 left-0 right-0 bg-kumo-base/95 backdrop-blur p-4 z-10",
				)}
			>
				<div className="flex items-center space-x-4">
					{!isDistractionFree && (
						<Link
							to="/content/$collection"
							params={{ collection }}
							search={{ locale: undefined }}
							aria-label={`Back to ${collectionLabel} list`}
							className={buttonVariants({ variant: "ghost", shape: "square" })}
						>
							<ArrowLeft className="h-5 w-5" aria-hidden="true" />
						</Link>
					)}
					{isDistractionFree && (
						<Button
							variant="ghost"
							shape="square"
							onClick={() => setIsDistractionFree(false)}
							aria-label="Exit distraction-free mode"
						>
							<ArrowsInSimple className="h-5 w-5" aria-hidden="true" />
						</Button>
					)}
					<h1 className="text-2xl font-bold">
						{isNew ? `New ${collectionLabel}` : `Edit ${collectionLabel}`}
					</h1>
					{i18n && item?.locale && (
						<Badge variant="outline" className="uppercase text-xs">
							{item.locale}
						</Badge>
					)}
				</div>
				<div className="flex items-center space-x-2">
					{/* Autosave indicator */}
					{!isNew && onAutosave && (
						<div className="flex items-center text-xs text-kumo-subtle">
							{isAutosaving ? (
								<>
									<Loader size="sm" />
									<span className="ml-1">Saving...</span>
								</>
							) : lastAutosaveAt ? (
								<>
									<Check className="mr-1 h-3 w-3 text-green-600" aria-hidden="true" />
									<span>Saved</span>
								</>
							) : null}
						</div>
					)}
					{!isDistractionFree && (
						<Button
							variant="ghost"
							shape="square"
							type="button"
							onClick={() => setIsDistractionFree(true)}
							aria-label="Enter distraction-free mode"
							title="Distraction-free mode (⌘⇧\)"
						>
							<ArrowsOutSimple className="h-4 w-4" aria-hidden="true" />
						</Button>
					)}
					{!isNew && supportsPreview && (
						<Button
							variant="outline"
							type="button"
							onClick={handlePreview}
							disabled={isLoadingPreview}
							icon={isLoadingPreview ? <Loader size="sm" /> : <Eye />}
						>
							{hasPendingChanges ? "Preview draft" : "Preview"}
						</Button>
					)}
					<SaveButton type="submit" isDirty={isDirty} isSaving={isSaving || false} />
					{!isNew && (
						<>
							{supportsDrafts && hasPendingChanges && onDiscardDraft && (
								<Dialog.Root disablePointerDismissal>
									<Dialog.Trigger
										render={(p) => (
											<Button {...p} type="button" variant="outline" size="sm" icon={<X />}>
												Discard changes
											</Button>
										)}
									/>
									<Dialog className="p-6" size="sm">
										<Dialog.Title className="text-lg font-semibold">
											Discard draft changes?
										</Dialog.Title>
										<Dialog.Description className="text-kumo-subtle">
											This will revert to the published version. Your draft changes will be lost.
										</Dialog.Description>
										<div className="mt-6 flex justify-end gap-2">
											<Dialog.Close
												render={(p) => (
													<Button {...p} variant="secondary">
														Cancel
													</Button>
												)}
											/>
											<Dialog.Close
												render={(p) => (
													<Button {...p} variant="destructive" onClick={onDiscardDraft}>
														Discard changes
													</Button>
												)}
											/>
										</div>
									</Dialog>
								</Dialog.Root>
							)}
							{isLive ? (
								<>
									{hasPendingChanges ? (
										<Button type="button" variant="primary" onClick={onPublish}>
											Publish changes
										</Button>
									) : (
										<Button type="button" variant="outline" onClick={onUnpublish}>
											Unpublish
										</Button>
									)}
								</>
							) : (
								<Button type="button" variant="secondary" onClick={onPublish}>
									Publish
								</Button>
							)}
							{isLive && item?.slug && (
								<a
									href={`/${item.slug}`}
									target="_blank"
									rel="noopener noreferrer"
									aria-label="View published page"
									className={buttonVariants({ variant: "ghost", shape: "square" })}
								>
									<ArrowSquareOut className="h-4 w-4" aria-hidden="true" />
								</a>
							)}
						</>
					)}
				</div>
			</div>

			{/* Main content area */}
			<div
				className={cn(
					"grid gap-6 lg:grid-cols-3",
					isDistractionFree && "lg:grid-cols-1 max-w-4xl mx-auto pt-16",
				)}
			>
				{/* Editor fields */}
				<div className="space-y-6 lg:col-span-2">
					<div
						className={cn(
							"rounded-lg border bg-kumo-base p-6",
							isDistractionFree && "border-0 bg-transparent p-0",
						)}
					>
						<div className="space-y-4">
							{Object.entries(fields).map(([name, field]) => {
								const fieldEl = (
									<FieldRenderer
										key={name}
										name={name}
										field={field}
										value={formData[name]}
										onChange={handleFieldChange}
										onEditorReady={
											field.kind === "portableText" ? setPortableTextEditor : undefined
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
								if (
									name === "featured_image" &&
									field.kind === "image" &&
									hasSeo &&
									!isNew &&
									onSeoChange
								) {
									return (
										<div key={`${name}-with-seo`} className="grid grid-cols-1 gap-6 md:grid-cols-2">
											<div>{fieldEl}</div>
											<div>
												<SeoImageField seo={item?.seo} onChange={onSeoChange} />
											</div>
										</div>
									);
								}
								return fieldEl;
							})}
						</div>
					</div>
				</div>

				{/* Sidebar - hidden in distraction-free mode */}
				<div className={cn("space-y-6", isDistractionFree && "hidden")}>
					{blockSidebarPanel ? (
						/* Block sidebar panel – replaces default sections when a block requests it */
						blockSidebarPanel.type === "image" ? (
							<ImageDetailPanel
								attributes={blockSidebarPanel.attrs as unknown as ImageAttributes}
								onUpdate={(attrs) =>
									blockSidebarPanel.onUpdate(attrs as unknown as Record<string, unknown>)
								}
								onReplace={(attrs) =>
									blockSidebarPanel.onReplace(attrs as unknown as Record<string, unknown>)
								}
								onDelete={() => {
									blockSidebarPanel.onDelete();
									setBlockSidebarPanel(null);
								}}
								onClose={handleBlockSidebarClose}
								inline
							/>
						) : null
					) : (
						/* Default content settings sections – single card with dividers */
						<div className="rounded-lg border bg-kumo-base flex flex-col">
							{/* Publish settings */}
							<div className="p-4">
								<h3 className="mb-4 font-semibold">Publish</h3>
								<div className="space-y-4">
									<Input
										label="Slug"
										value={slug}
										onChange={(e) => handleSlugChange(e.target.value)}
										placeholder="my-post-slug"
									/>
									<div>
										<Label>Status</Label>
										<div className="mt-1 flex flex-wrap items-center gap-1.5">
											{supportsDrafts ? (
												<>
													{isLive && <Badge variant="primary">Published</Badge>}
													{hasPendingChanges && <Badge variant="secondary">Pending changes</Badge>}
													{!isLive && !hasSchedule && <Badge variant="secondary">Draft</Badge>}
													{hasSchedule && <Badge variant="outline">Scheduled</Badge>}
												</>
											) : (
												<span className="text-sm text-kumo-subtle">
													{status.charAt(0).toUpperCase() + status.slice(1)}
												</span>
											)}
										</div>
										{item?.scheduledAt && (
											<div className="mt-2 flex items-center justify-between gap-2 rounded-md border px-3 py-2">
												<p className="text-xs text-kumo-subtle">
													Scheduled for: {formatScheduledDate(item.scheduledAt)}
												</p>
												<Button type="button" variant="outline" size="sm" onClick={onUnschedule}>
													Unschedule
												</Button>
											</div>
										)}
									</div>

									{canSchedule && (
										<div className="pt-2">
											{showScheduler ? (
												<div className="space-y-2">
													<Input
														label="Schedule for"
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
															Schedule
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
															Cancel
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
													Schedule for later
												</Button>
											)}
										</div>
									)}

									{item && (
										<div className="text-xs text-kumo-subtle">
											<p>Created: {new Date(item.createdAt).toLocaleString()}</p>
											<p>Updated: {new Date(item.updatedAt).toLocaleString()}</p>
										</div>
									)}
									{!isNew && onDelete && (
										<div className="pt-4 border-t">
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
															Move to Trash
														</Button>
													)}
												/>
												<Dialog className="p-6" size="sm">
													<Dialog.Title className="text-lg font-semibold">
														Move to Trash?
													</Dialog.Title>
													<Dialog.Description className="text-kumo-subtle">
														This will move the item to trash. You can restore it later from the
														trash.
													</Dialog.Description>
													<div className="mt-6 flex justify-end gap-2">
														<Dialog.Close
															render={(p) => (
																<Button {...p} variant="secondary">
																	Cancel
																</Button>
															)}
														/>
														<Dialog.Close
															render={(p) => (
																<Button {...p} variant="destructive" onClick={onDelete}>
																	Move to Trash
																</Button>
															)}
														/>
													</div>
												</Dialog>
											</Dialog.Root>
										</div>
									)}
								</div>
							</div>

							{/* Ownership selector - shown only to editors and above */}
							{currentUser && currentUser.role >= ROLE_EDITOR && users && users.length > 0 && (
								<div className="p-4 border-t">
									<h3 className="mb-4 font-semibold">Ownership</h3>
									<AuthorSelector
										authorId={item?.authorId ?? currentUser?.id ?? null}
										users={users}
										onChange={onAuthorChange}
									/>
								</div>
							)}

							{/* Byline credits */}
							{currentUser && currentUser.role >= ROLE_EDITOR && (
								<div className="p-4 border-t">
									<h3 className="mb-4 font-semibold">Bylines</h3>
									<BylineCreditsEditor
										credits={activeBylines}
										bylines={availableBylines ?? []}
										onChange={handleBylinesChange}
										onQuickCreate={onQuickCreateByline}
										onQuickEdit={onQuickEditByline}
									/>
								</div>
							)}

							{/* Translations sidebar - shown when i18n is enabled */}
							{i18n && item && !isNew && (
								<div className="p-4 border-t">
									<h3 className="mb-4 font-semibold">Translations</h3>
									<div className="space-y-2">
										{i18n.locales.map((locale) => {
											const translation = translations?.find((t) => t.locale === locale);
											const isCurrent = locale === item.locale;
											return (
												<div
													key={locale}
													className={cn(
														"flex items-center justify-between rounded-md px-3 py-2 text-sm",
														isCurrent
															? "bg-kumo-brand/10 font-medium"
															: translation
																? "hover:bg-kumo-tint/50"
																: "text-kumo-subtle",
													)}
												>
													<div className="flex items-center gap-2">
														<span className="text-xs font-semibold uppercase">{locale}</span>
														{locale === i18n.defaultLocale && (
															<span className="text-[10px] text-kumo-subtle">(default)</span>
														)}
														{isCurrent && (
															<span className="text-[10px] text-kumo-brand">current</span>
														)}
													</div>
													{translation && !isCurrent ? (
														<Link
															to="/content/$collection/$id"
															params={{ collection, id: translation.id }}
															className="text-xs text-kumo-brand hover:underline"
														>
															Edit
														</Link>
													) : !translation && onTranslate ? (
														<Button
															type="button"
															variant="ghost"
															size="sm"
															className="h-auto px-2 py-1 text-xs"
															onClick={() => onTranslate(locale)}
														>
															Translate
														</Button>
													) : null}
												</div>
											);
										})}
									</div>
								</div>
							)}

							{/* Taxonomy selector */}
							{item && (
								<div className="p-4 border-t">
									<TaxonomySidebar collection={collection} entryId={item.id} />
								</div>
							)}

							{/* SEO panel - shown for collections with hasSeo enabled */}
							{hasSeo && !isNew && onSeoChange && (
								<div className="p-4 border-t">
									<h3 className="mb-4 font-semibold flex items-center gap-2">
										<MagnifyingGlass className="h-4 w-4" />
										SEO
									</h3>
									<SeoPanel seo={item?.seo} onChange={onSeoChange} />
								</div>
							)}

							{/* Document outline - shown when editing content with portableText */}
							{portableTextEditor && (
								<div className="p-4 border-t">
									<DocumentOutline editor={portableTextEditor} />
								</div>
							)}

							{/* Revision history - shown for existing items in collections that support it */}
							{!isNew && item && supportsRevisions && (
								<div className="p-4 border-t">
									<RevisionHistory collection={collection} entryId={item.id} />
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</form>
	);
}

interface FieldRendererProps {
	name: string;
	field: FieldDescriptor;
	value: unknown;
	onChange: (name: string, value: unknown) => void;
	/** Callback when a portableText editor is ready */
	onEditorReady?: (editor: Editor) => void;
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
						options?: Array<{ value: string; label: string }>;
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
				<Switch
					label={label}
					checked={typeof value === "boolean" ? value : false}
					onCheckedChange={handleChange}
				/>
			);

		case "portableText": {
			const labelId = `${id}-label`;
			return (
				<div>
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
						placeholder={`Enter ${label.toLowerCase()}...`}
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
					placeholder="Enter markdown content..."
				/>
			);

		case "select": {
			const selectItems: Record<string, string> = {};
			for (const opt of field.options ?? []) {
				selectItems[opt.value] = opt.label;
			}
			return (
				<Select
					label={label}
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => handleChange(v ?? "")}
					items={selectItems}
				>
					{field.options?.map((opt) => (
						<Select.Option key={opt.value} value={opt.value}>
							{opt.label}
						</Select.Option>
					))}
				</Select>
			);
		}

		case "datetime":
			return (
				<Input
					label={label}
					id={id}
					type="datetime-local"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => handleChange(e.target.value)}
					required={field.required}
				/>
			);

		case "image": {
			// value is either an ImageFieldValue object, a legacy string URL, or undefined
			const imageValue =
				value != null && typeof value === "object" ? (value as ImageFieldValue) : undefined;
			return (
				<ImageFieldRenderer
					label={label}
					description={
						name === "featured_image"
							? "Used as the main visual for this post on listing pages and at the top of the post"
							: undefined
					}
					value={imageValue}
					onChange={handleChange}
					required={field.required}
				/>
			);
		}

		default:
			// Default to text input
			return (
				<Input
					label={label}
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => handleChange(e.target.value)}
					required={field.required}
				/>
			);
	}
}

/**
 * Image field value - matches emdash's MediaValue type
 */
interface ImageFieldValue {
	id: string;
	/** Provider ID (e.g., "local", "cloudflare-images") */
	provider?: string;
	/** Direct URL for local media or legacy data */
	src?: string;
	/** Preview URL for admin display (separate from src used for rendering) */
	previewUrl?: string;
	alt?: string;
	width?: number;
	height?: number;
	/** Provider-specific metadata */
	meta?: Record<string, unknown>;
}

/**
 * Image field with media picker
 *
 * Stores full image metadata including dimensions for responsive images.
 * Handles backwards compatibility with legacy string URLs.
 */
interface ImageFieldRendererProps {
	label: string;
	description?: string;
	value: ImageFieldValue | string | undefined;
	onChange: (value: ImageFieldValue | undefined) => void;
	required?: boolean;
}

function ImageFieldRenderer({
	label,
	description,
	value,
	onChange,
	required,
}: ImageFieldRendererProps) {
	const [pickerOpen, setPickerOpen] = React.useState(false);
	// Normalize value to get display URL (handles both object and legacy string)
	// Prefer previewUrl for admin display, fall back to src, then derive from storageKey/id
	const displayUrl =
		typeof value === "string"
			? value
			: value?.previewUrl ||
				value?.src ||
				(value && (!value.provider || value.provider === "local")
					? `/_emdash/api/media/file/${typeof value.meta?.storageKey === "string" ? value.meta.storageKey : value.id}`
					: undefined);

	const handleSelect = (item: MediaItem) => {
		const isLocalProvider = !item.provider || item.provider === "local";

		onChange({
			id: item.id,
			provider: item.provider || "local",
			// Local media derives URLs from meta.storageKey at display time — no src needed
			// External providers cache a preview URL for admin display
			previewUrl: isLocalProvider ? undefined : item.url,
			alt: item.alt || "",
			width: item.width,
			height: item.height,
			meta: isLocalProvider ? { ...item.meta, storageKey: item.storageKey } : item.meta,
		});
	};

	const handleRemove = () => {
		onChange(undefined);
	};

	return (
		<div>
			<Label>{label}</Label>
			{displayUrl ? (
				<div className="mt-2 relative group">
					<img src={displayUrl} alt="" className="max-h-48 rounded-lg border object-cover" />
					<div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
						<Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
							Change
						</Button>
						<Button
							type="button"
							shape="square"
							variant="destructive"
							className="h-8 w-8"
							onClick={handleRemove}
							aria-label="Remove image"
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					className="mt-2 w-full h-32 border-dashed"
					onClick={() => setPickerOpen(true)}
				>
					<div className="flex flex-col items-center gap-2 text-kumo-subtle">
						<ImageIcon className="h-8 w-8" />
						<span>Select image</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilter="image/"
				title={`Select ${label}`}
			/>
			{description && <p className="text-xs text-kumo-subtle mt-1">{description}</p>}
			{required && !displayUrl && (
				<p className="text-sm text-kumo-danger mt-1">This field is required</p>
			)}
		</div>
	);
}

/**
 * Author selector component for editors and above
 */
interface AuthorSelectorProps {
	authorId: string | null;
	users: UserListItem[];
	onChange?: (authorId: string | null) => void;
}

interface BylineCreditsEditorProps {
	credits: BylineCreditInput[];
	bylines: BylineSummary[];
	onChange: (bylines: BylineCreditInput[]) => void;
	onQuickCreate?: (input: { slug: string; displayName: string }) => Promise<BylineSummary>;
	onQuickEdit?: (
		bylineId: string,
		input: { slug: string; displayName: string },
	) => Promise<BylineSummary>;
}

function BylineCreditsEditor({
	credits,
	bylines,
	onChange,
	onQuickCreate,
	onQuickEdit,
}: BylineCreditsEditorProps) {
	const [selectedBylineId, setSelectedBylineId] = React.useState("");
	const [quickName, setQuickName] = React.useState("");
	const [quickSlug, setQuickSlug] = React.useState("");
	const [quickError, setQuickError] = React.useState<string | null>(null);
	const [isCreating, setIsCreating] = React.useState(false);
	const [editBylineId, setEditBylineId] = React.useState<string | null>(null);
	const [editName, setEditName] = React.useState("");
	const [editSlug, setEditSlug] = React.useState("");
	const [editError, setEditError] = React.useState<string | null>(null);
	const [isEditing, setIsEditing] = React.useState(false);

	const bylineMap = React.useMemo(() => new Map(bylines.map((b) => [b.id, b])), [bylines]);

	const availableToAdd = bylines.filter((b) => !credits.some((c) => c.bylineId === b.id));

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

	return (
		<div className="space-y-3">
			<div className="flex gap-2">
				<select
					value={selectedBylineId}
					onChange={(e) => setSelectedBylineId(e.target.value)}
					className="w-full rounded border bg-kumo-base px-3 py-2 text-sm"
				>
					<option value="">Select byline...</option>
					{availableToAdd.map((b) => (
						<option key={b.id} value={b.id}>
							{b.displayName}
						</option>
					))}
				</select>
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						if (!selectedBylineId) return;
						onChange([...credits, { bylineId: selectedBylineId, roleLabel: null }]);
						setSelectedBylineId("");
					}}
					disabled={!selectedBylineId}
				>
					Add
				</Button>
			</div>

			{credits.length > 0 ? (
				<div className="space-y-2">
					{credits.map((credit, index) => {
						const byline = bylineMap.get(credit.bylineId);
						if (!byline) return null;
						return (
							<div key={`${credit.bylineId}-${index}`} className="rounded border p-2 space-y-2">
								<div className="flex items-center justify-between gap-2">
									<div>
										<p className="text-sm font-medium">{byline.displayName}</p>
										<p className="text-xs text-kumo-subtle">{byline.slug}</p>
									</div>
									<div className="flex gap-1">
										<Button type="button" variant="ghost" size="sm" onClick={() => move(index, -1)}>
											Up
										</Button>
										<Button type="button" variant="ghost" size="sm" onClick={() => move(index, 1)}>
											Down
										</Button>
										{onQuickEdit && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => openEditByline(byline)}
											>
												Edit
											</Button>
										)}
										<Button
											type="button"
											variant="destructive"
											size="sm"
											onClick={() => onChange(credits.filter((_, i) => i !== index))}
										>
											Remove
										</Button>
									</div>
								</div>
								<Input
									label="Role label"
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
				<p className="text-sm text-kumo-subtle">No bylines selected.</p>
			)}

			{onQuickCreate && (
				<Dialog.Root>
					<Dialog.Trigger
						render={(p) => (
							<Button {...p} type="button" variant="secondary">
								Quick create byline
							</Button>
						)}
					/>
					<Dialog className="p-6" size="sm">
						<Dialog.Title className="text-lg font-semibold">Create byline</Dialog.Title>
						<div className="mt-4 space-y-3">
							<Input
								label="Display name"
								value={quickName}
								onChange={(e) => {
									setQuickName(e.target.value);
									if (!quickSlug) setQuickSlug(slugify(e.target.value));
								}}
							/>
							<Input
								label="Slug"
								value={quickSlug}
								onChange={(e) => setQuickSlug(e.target.value)}
							/>
							{quickError && <p className="text-sm text-kumo-danger">{quickError}</p>}
						</div>
						<div className="mt-6 flex justify-end gap-2">
							<Dialog.Close
								render={(p) => (
									<Button {...p} variant="secondary" onClick={resetQuickCreate}>
										Cancel
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
										setQuickError(err instanceof Error ? err.message : "Failed to create byline");
									} finally {
										setIsCreating(false);
									}
								}}
							>
								{isCreating ? "Creating..." : "Create"}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}

			{onQuickEdit && editBylineId && (
				<Dialog.Root open onOpenChange={(open) => (!open ? resetQuickEdit() : undefined)}>
					<Dialog className="p-6" size="sm">
						<Dialog.Title className="text-lg font-semibold">Edit byline</Dialog.Title>
						<div className="mt-4 space-y-3">
							<Input
								label="Display name"
								value={editName}
								onChange={(e) => {
									setEditName(e.target.value);
									if (!editSlug) setEditSlug(slugify(e.target.value));
								}}
							/>
							<Input label="Slug" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} />
							{editError && <p className="text-sm text-kumo-danger">{editError}</p>}
						</div>
						<div className="mt-6 flex justify-end gap-2">
							<Button type="button" variant="secondary" onClick={resetQuickEdit}>
								Cancel
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
										setEditError(err instanceof Error ? err.message : "Failed to update byline");
									} finally {
										setIsEditing(false);
									}
								}}
							>
								{isEditing ? "Saving..." : "Save"}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>
			)}
		</div>
	);
}

function AuthorSelector({ authorId, users, onChange }: AuthorSelectorProps) {
	const currentAuthor = users.find((u) => u.id === authorId);

	const authorItems: Record<string, string> = { unassigned: "Unassigned" };
	for (const user of users) {
		authorItems[user.id] = user.name || user.email;
	}

	return (
		<div className="space-y-2">
			<Select
				value={authorId || "unassigned"}
				onValueChange={(value) =>
					onChange?.(value === "unassigned" || value === null ? null : value)
				}
				items={authorItems}
			>
				<Select.Option value="unassigned">
					<span className="text-kumo-subtle">Unassigned</span>
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
