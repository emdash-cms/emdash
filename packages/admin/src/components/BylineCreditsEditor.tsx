import {
	Autocomplete,
	Badge,
	Button,
	Collapsible,
	Dialog,
	DropdownMenu,
	Input,
	LayerCard,
	Loader,
	Popover,
	Text,
} from "@cloudflare/kumo";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	type Modifier,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	sortableKeyboardCoordinates,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import {
	DotsSixVertical,
	DotsThree,
	PencilSimple,
	Plus,
	Tag,
	UserMinus,
	X,
} from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchBylines, type BylineCreditInput, type BylineSummary } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

const BYLINE_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const BYLINE_SLUG_MAX_LENGTH = 80;
const COMBINING_MARK_PATTERN = /[\u0300-\u036f]/g;
const UNSAFE_SLUG_PATTERN = /[^a-z0-9]+/g;
const MULTIPLE_HYPHENS_PATTERN = /-+/g;
const EDGE_HYPHENS_PATTERN = /^-+|-+$/g;
const LEADING_LETTER_PATTERN = /^[a-z]/;
const TRAILING_HYPHENS_PATTERN = /-+$/g;

const restrictToBylineList: Modifier = ({ activeNodeRect, containerNodeRect, transform }) => {
	if (!containerNodeRect || !activeNodeRect) return { ...transform, x: 0 };
	const minY = containerNodeRect.top - activeNodeRect.top;
	const maxY = containerNodeRect.bottom - activeNodeRect.bottom;
	return {
		...transform,
		x: 0,
		y: Math.min(maxY, Math.max(minY, transform.y)),
	};
};

function stableHash(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(36).padStart(7, "0");
}

export function toBylineSlug(value: string): string {
	const normalized = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(COMBINING_MARK_PATTERN, "")
		.replace(UNSAFE_SLUG_PATTERN, "-")
		.replace(MULTIPLE_HYPHENS_PATTERN, "-")
		.replace(EDGE_HYPHENS_PATTERN, "");
	const withLeadingLetter = LEADING_LETTER_PATTERN.test(normalized)
		? normalized
		: normalized
			? `byline-${normalized}`
			: `byline-${stableHash(value.normalize("NFKC").toLowerCase())}`;
	return withLeadingLetter.slice(0, BYLINE_SLUG_MAX_LENGTH).replace(TRAILING_HYPHENS_PATTERN, "");
}

type BylineOption = { type: "byline"; byline: BylineSummary } | { type: "create"; label: string };

export interface BylineCreditsEditorProps {
	credits: BylineCreditInput[];
	inferredByline?: BylineSummary | null;
	bylines: BylineSummary[];
	selectedBylineDetails?: BylineSummary[];
	bylinesLoaded?: boolean;
	onChange: (bylines: BylineCreditInput[]) => void;
	onQuickCreate?: (input: { slug: string; displayName: string }) => Promise<BylineSummary>;
	onQuickEdit?: (
		bylineId: string,
		input: { slug: string; displayName: string },
	) => Promise<BylineSummary>;
	entryLocale?: string | null;
	i18n?: { defaultLocale: string; locales: string[] } | null;
}

export function BylineCreditsEditor({
	credits,
	inferredByline,
	bylines,
	selectedBylineDetails,
	bylinesLoaded = true,
	onChange,
	onQuickCreate,
	onQuickEdit,
	entryLocale,
	i18n,
}: BylineCreditsEditorProps) {
	const { t } = useLingui();
	const [chooserOpen, setChooserOpen] = React.useState(false);
	const [autocompleteOpen, setAutocompleteOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const [knownBylines, setKnownBylines] = React.useState<Record<string, BylineSummary>>({});
	const [announcement, setAnnouncement] = React.useState("");
	const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
	const [roleEditorId, setRoleEditorId] = React.useState<string | null>(null);
	const [roleDraft, setRoleDraft] = React.useState("");
	const [createOpen, setCreateOpen] = React.useState(false);
	const [createName, setCreateName] = React.useState("");
	const [createSlug, setCreateSlug] = React.useState("");
	const [createSlugTouched, setCreateSlugTouched] = React.useState(false);
	const [createErrors, setCreateErrors] = React.useState<{ name?: string; slug?: string }>({});
	const [createError, setCreateError] = React.useState<unknown>(null);
	const [isCreating, setIsCreating] = React.useState(false);
	const [createAdvancedOpen, setCreateAdvancedOpen] = React.useState(false);
	const [createPendingOpen, setCreatePendingOpen] = React.useState(false);
	const [editBylineId, setEditBylineId] = React.useState<string | null>(null);
	const [editName, setEditName] = React.useState("");
	const [editSlug, setEditSlug] = React.useState("");
	const [editErrors, setEditErrors] = React.useState<{ name?: string; slug?: string }>({});
	const [editError, setEditError] = React.useState<unknown>(null);
	const [isEditing, setIsEditing] = React.useState(false);
	const [editAdvancedOpen, setEditAdvancedOpen] = React.useState(false);
	const chooserRef = React.useRef<HTMLDivElement>(null);
	const chooserTriggerRef = React.useRef<HTMLButtonElement | null>(null);
	const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
	const creditsRef = React.useRef(credits);
	creditsRef.current = credits;

	const debouncedSearch = useDebouncedValue(search, 300);
	const trimmedSearch = debouncedSearch.trim();
	const searchEnabled = chooserOpen && trimmedSearch.length > 0;
	const searchResults = useQuery({
		queryKey: ["bylines", "credit-picker", entryLocale ?? null, trimmedSearch],
		queryFn: () =>
			fetchBylines({ search: trimmedSearch, locale: entryLocale ?? undefined, limit: 20 }),
		enabled: searchEnabled,
		placeholderData: keepPreviousData,
	});

	const bylineMap = React.useMemo(() => {
		const map = new Map<string, BylineSummary>();
		for (const byline of selectedBylineDetails ?? []) map.set(byline.id, byline);
		for (const byline of bylines) map.set(byline.id, byline);
		for (const byline of searchResults.data?.items ?? []) map.set(byline.id, byline);
		for (const byline of Object.values(knownBylines)) map.set(byline.id, byline);
		return map;
	}, [bylines, knownBylines, searchResults.data?.items, selectedBylineDetails]);

	const resultPool = searchEnabled
		? searchResults.isError
			? []
			: (searchResults.data?.items ?? [])
		: bylines;
	const selectedIds = React.useMemo(
		() => new Set(credits.map((credit) => credit.bylineId)),
		[credits],
	);
	const availableResults = resultPool.filter((byline) => !selectedIds.has(byline.id));
	const normalizedSearch = trimmedSearch.toLocaleLowerCase();
	const generatedSearchSlug = toBylineSlug(trimmedSearch);
	const hasExactMatch = resultPool.some(
		(byline) =>
			byline.displayName.trim().toLocaleLowerCase() === normalizedSearch ||
			byline.slug === generatedSearchSlug,
	);
	const showCreate =
		!!onQuickCreate &&
		searchEnabled &&
		searchResults.isSuccess &&
		!searchResults.isFetching &&
		!hasExactMatch;
	const options = React.useMemo<BylineOption[]>(
		() => [
			...availableResults.map((byline) => ({ type: "byline" as const, byline })),
			...(showCreate ? [{ type: "create" as const, label: trimmedSearch }] : []),
		],
		[availableResults, showCreate, trimmedSearch],
	);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const focusChooser = React.useCallback(() => {
		requestAnimationFrame(() =>
			chooserRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }),
		);
	}, []);
	const focusRow = React.useCallback((id: string) => {
		requestAnimationFrame(() =>
			rowRefs.current
				.get(id)
				?.querySelector<HTMLButtonElement>('button[aria-label^="More actions for"]')
				?.focus(),
		);
	}, []);

	const changeCredits = React.useCallback(
		(next: BylineCreditInput[]) => {
			creditsRef.current = next;
			onChange(next);
		},
		[onChange],
	);

	const openChooser = React.useCallback(() => {
		setChooserOpen(true);
		setAutocompleteOpen(true);
		focusChooser();
	}, [focusChooser]);

	const closeChooser = React.useCallback((restoreFocus = true) => {
		setChooserOpen(false);
		setAutocompleteOpen(false);
		setSearch("");
		if (restoreFocus) requestAnimationFrame(() => chooserTriggerRef.current?.focus());
	}, []);

	const addByline = React.useCallback(
		(byline: BylineSummary) => {
			const current = creditsRef.current;
			if (current.some((credit) => credit.bylineId === byline.id)) return;
			setKnownBylines((known) => ({ ...known, [byline.id]: byline }));
			changeCredits([...current, { bylineId: byline.id, roleLabel: null }]);
			closeChooser();
			setAnnouncement(t`${byline.displayName} added to this post.`);
			focusRow(byline.id);
		},
		[changeCredits, closeChooser, focusRow, t],
	);

	const handleDragStart = React.useCallback((event: DragStartEvent) => {
		setActiveDragId(String(event.active.id));
	}, []);
	const handleDragEnd = React.useCallback(
		(event: DragEndEvent) => {
			setActiveDragId(null);
			if (!event.over || event.active.id === event.over.id) return;
			const current = creditsRef.current;
			const from = current.findIndex((credit) => credit.bylineId === event.active.id);
			const to = current.findIndex((credit) => credit.bylineId === event.over?.id);
			if (from < 0 || to < 0) return;
			changeCredits(arrayMove(current, from, to));
			const id = String(event.active.id);
			const label = bylineMap.get(id)?.displayName ?? t`Byline`;
			setAnnouncement(t`${label} moved to position ${to + 1}.`);
			focusRow(id);
		},
		[bylineMap, changeCredits, focusRow, t],
	);

	const openCreate = React.useCallback(() => {
		const name = search.trim();
		setCreateName(name);
		setCreateSlug(toBylineSlug(name));
		setCreateSlugTouched(false);
		setCreateErrors({});
		setCreateError(null);
		setCreateAdvancedOpen(false);
		setAutocompleteOpen(false);
		setCreatePendingOpen(true);
		setChooserOpen(false);
	}, [search]);

	const validateProfile = React.useCallback(
		(name: string, slug: string) => {
			const errors: { name?: string; slug?: string } = {};
			if (!name.trim()) errors.name = t`Enter a name.`;
			if (!BYLINE_SLUG_PATTERN.test(slug)) {
				errors.slug = t`Use lowercase letters, numbers, and hyphens, starting with a letter.`;
			}
			return errors;
		},
		[t],
	);

	const submitCreate = React.useCallback(async () => {
		if (!onQuickCreate || isCreating) return;
		const errors = validateProfile(createName, createSlug);
		setCreateErrors(errors);
		if (errors.name || errors.slug) {
			if (errors.slug) setCreateAdvancedOpen(true);
			requestAnimationFrame(() =>
				document.getElementById(errors.name ? "byline-create-name" : "byline-create-slug")?.focus(),
			);
			return;
		}
		setCreateError(null);
		setIsCreating(true);
		try {
			const created = await onQuickCreate({ displayName: createName.trim(), slug: createSlug });
			setCreateOpen(false);
			addByline(created);
		} catch (error) {
			setCreateError(error);
		} finally {
			setIsCreating(false);
		}
	}, [addByline, createName, createSlug, isCreating, onQuickCreate, validateProfile]);

	const openEdit = React.useCallback((byline: BylineSummary) => {
		setEditName(byline.displayName);
		setEditSlug(byline.slug);
		setEditErrors({});
		setEditError(null);
		setEditAdvancedOpen(false);
		requestAnimationFrame(() => setEditBylineId(byline.id));
	}, []);

	const submitEdit = React.useCallback(async () => {
		if (!editBylineId || !onQuickEdit || isEditing) return;
		const errors = validateProfile(editName, editSlug);
		setEditErrors(errors);
		if (errors.name || errors.slug) {
			if (errors.slug) setEditAdvancedOpen(true);
			requestAnimationFrame(() =>
				document.getElementById(errors.name ? "byline-edit-name" : "byline-edit-slug")?.focus(),
			);
			return;
		}
		setEditError(null);
		setIsEditing(true);
		try {
			const updated = await onQuickEdit(editBylineId, {
				displayName: editName.trim(),
				slug: editSlug,
			});
			setKnownBylines((known) => ({ ...known, [updated.id]: updated }));
			setEditBylineId(null);
			setAnnouncement(t`${updated.displayName} updated everywhere it appears.`);
			focusRow(updated.id);
		} catch (error) {
			setEditError(error);
		} finally {
			setIsEditing(false);
		}
	}, [editBylineId, editName, editSlug, focusRow, isEditing, onQuickEdit, t, validateProfile]);

	const isMultiLocale = !!i18n && i18n.locales.length > 1;
	const showLocaleEmptyState =
		isMultiLocale && bylinesLoaded && bylines.length === 0 && !!entryLocale;

	return (
		<div className="space-y-4">
			<Popover
				open={chooserOpen}
				onOpenChange={(open) => (open ? openChooser() : closeChooser(false))}
				onOpenChangeComplete={(open) => {
					if (!open && createPendingOpen) {
						setCreatePendingOpen(false);
						setCreateOpen(true);
					}
				}}
			>
				<Popover.Content
					align="end"
					positionMethod="fixed"
					className="w-80 max-w-[calc(100vw-2rem)]"
				>
					<div
						ref={chooserRef}
						className="space-y-3"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								closeChooser();
							}
						}}
					>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0 space-y-1">
								<Popover.Title>{t`Add byline`}</Popover.Title>
								<Popover.Description>{t`Search reusable public profiles.`}</Popover.Description>
							</div>
							<Popover.Close
								render={
									<Button
										type="button"
										variant="ghost"
										shape="square"
										icon={<X aria-hidden="true" />}
										aria-label={t`Close byline search`}
									/>
								}
							/>
						</div>

						<div className="[&>div>label]:sr-only">
							<Autocomplete
								items={options}
								value={search}
								onValueChange={(value) => {
									setSearch(String(value ?? ""));
									setAutocompleteOpen(true);
								}}
								open={autocompleteOpen && options.length > 0}
								onOpenChange={setAutocompleteOpen}
								mode="none"
								autoHighlight="always"
								openOnInputClick
								itemToStringValue={(option: BylineOption) =>
									option.type === "byline" ? option.byline.displayName : option.label
								}
								label={t`Search bylines`}
							>
								<Autocomplete.InputGroup size="base" placeholder={t`Search by name…`} />
								<Autocomplete.Content>
									<Autocomplete.List className="max-h-64 overflow-y-auto">
										{(option: BylineOption) => (
											<Autocomplete.Item
												key={option.type === "byline" ? option.byline.id : "create"}
												value={option}
												onClick={() => {
													if (option.type === "byline") addByline(option.byline);
													else openCreate();
												}}
											>
												{option.type === "byline" ? (
													<span className="grid min-w-0 gap-0.5">
														<Text bold as="span" DANGEROUS_className="wrap-break-word">
															{option.byline.displayName}
														</Text>
														<Text
															as="span"
															variant="secondary"
															DANGEROUS_className="wrap-break-word"
														>
															{option.byline.slug}
														</Text>
													</span>
												) : (
													<span className="flex items-center gap-2">
														<Plus aria-hidden="true" />
														{t`Create “${option.label}”`}
													</span>
												)}
											</Autocomplete.Item>
										)}
									</Autocomplete.List>
								</Autocomplete.Content>
							</Autocomplete>
						</div>

						{searchEnabled && searchResults.isLoading && !searchResults.data ? (
							<div className="flex items-center gap-2">
								<Loader size="sm" />
								<Text variant="secondary">{t`Searching…`}</Text>
							</div>
						) : null}
						{searchEnabled && searchResults.isFetching && searchResults.data ? (
							<div className="flex items-center gap-2">
								<Loader size="sm" />
								<Text variant="secondary">{t`Updating results…`}</Text>
							</div>
						) : null}
						{searchEnabled && searchResults.isError ? (
							<div className="space-y-2">
								<Text variant="error">{t`Couldn’t search bylines.`}</Text>
								<Button type="button" variant="secondary" onClick={() => searchResults.refetch()}>
									{t`Retry`}
								</Button>
							</div>
						) : null}
						{searchEnabled && searchResults.isSuccess && options.length === 0 ? (
							<Text variant="secondary">{t`No matching bylines.`}</Text>
						) : null}
						{(searchResults.data?.nextCursor || (!searchEnabled && bylines.length >= 100)) && (
							<Text variant="secondary">{t`Keep typing to narrow the list.`}</Text>
						)}
					</div>
				</Popover.Content>
				<>
					{credits.length > 0 ? (
						<>
							<Popover.Trigger
								render={
									<Button
										ref={chooserTriggerRef}
										type="button"
										variant="ghost"
										shape="square"
										icon={<Plus aria-hidden="true" />}
										className="absolute end-14 top-2"
										aria-label={t`Add another byline`}
										data-keep-mobile-sidebar-open
									/>
								}
							/>
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								modifiers={[restrictToBylineList]}
								onDragStart={handleDragStart}
								onDragCancel={() => setActiveDragId(null)}
								onDragEnd={handleDragEnd}
							>
								<SortableContext
									items={credits.map((credit) => credit.bylineId)}
									strategy={verticalListSortingStrategy}
								>
									<div className="space-y-2">
										{credits.map((credit) => {
											const byline = bylineMap.get(credit.bylineId);
											if (!byline) return null;
											return (
												<SortableBylineRow
													key={credit.bylineId}
													credit={credit}
													byline={byline}
													isSorting={activeDragId !== null}
													roleOpen={roleEditorId === credit.bylineId}
													roleDraft={roleDraft}
													onRoleDraftChange={setRoleDraft}
													onOpenRole={() => {
														setRoleEditorId(credit.bylineId);
														setRoleDraft(credit.roleLabel ?? "");
													}}
													onCancelRole={() => {
														setRoleEditorId(null);
														focusRow(credit.bylineId);
													}}
													onCommitRole={() => {
														changeCredits(
															creditsRef.current.map((entry) =>
																entry.bylineId === credit.bylineId
																	? { ...entry, roleLabel: roleDraft || null }
																	: entry,
															),
														);
														setRoleEditorId(null);
														setAnnouncement(t`Role updated for ${byline.displayName}.`);
														focusRow(credit.bylineId);
													}}
													onEdit={onQuickEdit ? () => openEdit(byline) : undefined}
													onRemove={() => {
														changeCredits(
															creditsRef.current.filter(
																(entry) => entry.bylineId !== credit.bylineId,
															),
														);
														setAnnouncement(t`${byline.displayName} removed from this post.`);
													}}
													rowRef={(node) => {
														if (node) rowRefs.current.set(credit.bylineId, node);
														else rowRefs.current.delete(credit.bylineId);
													}}
												/>
											);
										})}
									</div>
								</SortableContext>
							</DndContext>
						</>
					) : inferredByline ? (
						<div className="space-y-3">
							<Text variant="secondary">{t`People shown publicly on this post.`}</Text>
							<div className="flex flex-wrap items-center gap-2">
								<Text bold as="span">
									{inferredByline.displayName}
								</Text>
								<Badge variant="secondary">{t`Automatic`}</Badge>
							</div>
							<Text as="p" variant="secondary">
								{t`From the post owner`}
							</Text>
							<Text as="p" variant="secondary">
								{t`Choosing a byline replaces this automatic credit.`}
							</Text>
							<Popover.Trigger
								render={
									<Button
										ref={chooserTriggerRef}
										type="button"
										variant="secondary"
										className="w-full"
										data-keep-mobile-sidebar-open
									>
										{t`Choose bylines`}
									</Button>
								}
							/>
						</div>
					) : (
						<div className="space-y-3">
							<Text variant="secondary">{t`People shown publicly on this post.`}</Text>
							<Text variant="secondary">{t`No byline is shown on this post.`}</Text>
							<Popover.Trigger
								render={
									<Button
										ref={chooserTriggerRef}
										type="button"
										variant="secondary"
										className="w-full"
										data-keep-mobile-sidebar-open
									>
										{t`Choose bylines`}
									</Button>
								}
							/>
						</div>
					)}

					{showLocaleEmptyState ? (
						<div className="space-y-2 rounded-lg border border-dashed p-3">
							<Text variant="secondary">
								{t`No bylines available in ${entryLocale}. Create a variant from the Bylines page before crediting one on this entry.`}
							</Text>
							<RouterLinkButton
								to="/bylines"
								search={{ locale: entryLocale ?? undefined }}
								variant="secondary"
								size="sm"
							>
								{t`Manage bylines in ${entryLocale}`}
							</RouterLinkButton>
						</div>
					) : null}
				</>
			</Popover>

			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>

			<BylineProfileDialog
				kind="create"
				open={createOpen}
				onOpenChange={(open) => {
					if (!open && isCreating) return;
					setCreateOpen(open);
					if (!open) {
						requestAnimationFrame(openChooser);
					}
				}}
				name={createName}
				slug={createSlug}
				onNameChange={(value) => {
					setCreateName(value);
					setCreateErrors((errors) => ({ ...errors, name: undefined }));
					if (!createSlugTouched) setCreateSlug(toBylineSlug(value));
				}}
				onSlugChange={(value) => {
					setCreateSlug(value);
					setCreateSlugTouched(true);
					setCreateErrors((errors) => ({ ...errors, slug: undefined }));
				}}
				nameError={createErrors.name}
				slugError={createErrors.slug}
				mutationError={createError}
				pending={isCreating}
				advancedOpen={createAdvancedOpen}
				onAdvancedOpenChange={setCreateAdvancedOpen}
				onSubmit={submitCreate}
			/>

			<BylineProfileDialog
				kind="edit"
				open={editBylineId !== null}
				onOpenChange={(open) => {
					if (!open && isEditing) return;
					if (!open) {
						const id = editBylineId;
						setEditBylineId(null);
						if (id) focusRow(id);
					}
				}}
				name={editName}
				slug={editSlug}
				onNameChange={(value) => {
					setEditName(value);
					setEditErrors((errors) => ({ ...errors, name: undefined }));
				}}
				onSlugChange={(value) => {
					setEditSlug(value);
					setEditErrors((errors) => ({ ...errors, slug: undefined }));
				}}
				nameError={editErrors.name}
				slugError={editErrors.slug}
				mutationError={editError}
				pending={isEditing}
				advancedOpen={editAdvancedOpen}
				onAdvancedOpenChange={setEditAdvancedOpen}
				onSubmit={submitEdit}
			/>
		</div>
	);
}

interface SortableBylineRowProps {
	credit: BylineCreditInput;
	byline: BylineSummary;
	isSorting: boolean;
	roleOpen: boolean;
	roleDraft: string;
	onRoleDraftChange: (value: string) => void;
	onOpenRole: () => void;
	onCancelRole: () => void;
	onCommitRole: () => void;
	onEdit?: () => void;
	onRemove: () => void;
	rowRef: (node: HTMLDivElement | null) => void;
}

function SortableBylineRow({
	credit,
	byline,
	isSorting,
	roleOpen,
	roleDraft,
	onRoleDraftChange,
	onOpenRole,
	onCancelRole,
	onCommitRole,
	onEdit,
	onRemove,
	rowRef,
}: SortableBylineRowProps) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: credit.bylineId,
	});
	const setRefs = React.useCallback(
		(node: HTMLDivElement | null) => {
			setNodeRef(node);
			rowRef(node);
		},
		[rowRef, setNodeRef],
	);

	return (
		<LayerCard
			ref={setRefs}
			className="relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-2"
			style={{
				transform: transform ? CSS.Transform.toString(transform) : undefined,
				transition,
				zIndex: isDragging ? 10 : undefined,
			}}
		>
			<Button
				type="button"
				variant="ghost"
				shape="square"
				icon={<DotsSixVertical aria-hidden="true" />}
				aria-label={t`Reorder ${byline.displayName}`}
				data-sortable-handle
				data-sorting={isSorting ? "true" : "false"}
				{...attributes}
				{...listeners}
			/>

			<div className="min-w-0">
				<Text bold as="span" DANGEROUS_className="block wrap-break-word">
					{byline.displayName}
				</Text>
				{credit.roleLabel ? (
					<Text as="span" variant="secondary" DANGEROUS_className="block wrap-break-word">
						{credit.roleLabel}
					</Text>
				) : null}
			</div>

			<DropdownMenu>
				<DropdownMenu.Trigger
					render={
						<Button
							type="button"
							variant="ghost"
							shape="square"
							icon={<DotsThree aria-hidden="true" />}
							aria-label={t`More actions for ${byline.displayName}`}
						/>
					}
				/>
				<DropdownMenu.Content>
					<DropdownMenu.Item
						icon={<Tag className="me-2 size-4" aria-hidden="true" />}
						onClick={onOpenRole}
					>
						{credit.roleLabel ? t`Edit role` : t`Set role`}
					</DropdownMenu.Item>
					{onEdit ? (
						<DropdownMenu.Item
							icon={<PencilSimple className="me-2 size-4" aria-hidden="true" />}
							onClick={onEdit}
						>
							{t`Edit name and slug`}
						</DropdownMenu.Item>
					) : null}
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						icon={<UserMinus className="me-2 size-4" aria-hidden="true" />}
						variant="danger"
						onClick={onRemove}
					>
						{t`Remove from post`}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu>

			<Collapsible.Root
				className="col-span-full"
				open={roleOpen}
				onOpenChange={(open) => !open && onCancelRole()}
			>
				<Collapsible.Panel>
					<div className="space-y-2 pt-2">
						<Input
							size="base"
							label={t`Role on this post (optional)`}
							value={roleDraft}
							onChange={(event) => onRoleDraftChange(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									onCancelRole();
								}
							}}
							autoFocus={roleOpen}
						/>
						<Button type="button" variant="secondary" onClick={onCommitRole}>
							{t`Done`}
						</Button>
					</div>
				</Collapsible.Panel>
			</Collapsible.Root>
		</LayerCard>
	);
}

interface BylineProfileDialogProps {
	kind: "create" | "edit";
	open: boolean;
	onOpenChange: (open: boolean) => void;
	name: string;
	slug: string;
	onNameChange: (value: string) => void;
	onSlugChange: (value: string) => void;
	nameError?: string;
	slugError?: string;
	mutationError: unknown;
	pending: boolean;
	advancedOpen: boolean;
	onAdvancedOpenChange: (open: boolean) => void;
	onSubmit: () => void;
}

function BylineProfileDialog({
	kind,
	open,
	onOpenChange,
	name,
	slug,
	onNameChange,
	onSlugChange,
	nameError,
	slugError,
	mutationError,
	pending,
	advancedOpen,
	onAdvancedOpenChange,
	onSubmit,
}: BylineProfileDialogProps) {
	const { t } = useLingui();
	const prefix = kind === "create" ? "byline-create" : "byline-edit";
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">
					{kind === "create" ? t`Create byline` : t`Edit name and slug`}
				</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle">
					{kind === "create"
						? t`Create a reusable public profile, then add it to this post.`
						: t`Changes apply everywhere this byline appears.`}
				</Dialog.Description>

				<div className="mt-4 space-y-3">
					<Input
						id={`${prefix}-name`}
						size="base"
						label={t`Name`}
						value={name}
						onChange={(event) => onNameChange(event.target.value)}
						error={nameError}
						autoFocus={open}
					/>

					<Collapsible.Root open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
						<Collapsible.DefaultTrigger>{t`Advanced`}</Collapsible.DefaultTrigger>
						<Collapsible.DefaultPanel>
							<div className="pt-3">
								<Input
									id={`${prefix}-slug`}
									size="base"
									label={t`URL slug`}
									description={t`Generated automatically.`}
									value={slug}
									onChange={(event) => onSlugChange(event.target.value)}
									error={slugError}
								/>
							</div>
						</Collapsible.DefaultPanel>
					</Collapsible.Root>

					<DialogError message={getMutationError(mutationError)} />
				</div>

				<div className="mt-6 flex flex-wrap justify-end gap-2">
					<Button
						type="button"
						variant="secondary"
						disabled={pending}
						onClick={() => onOpenChange(false)}
					>
						{t`Cancel`}
					</Button>
					<Button type="button" variant="primary" loading={pending} onClick={onSubmit}>
						{kind === "create" ? t`Create and add` : t`Save changes`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
