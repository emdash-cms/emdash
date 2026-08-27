/**
 * Taxonomy Terms Manager
 *
 * Provides UI for managing taxonomy terms (categories, tags, custom taxonomies).
 * Shows hierarchical structure for categories, flat list for tags.
 */

import { Button, Checkbox, Dialog, Input, InputArea, Select, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, CaretUp, Plus, Pencil, Trash, X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchManifest } from "../lib/api/client.js";
import type { TaxonomyTerm, TaxonomyDef, CreateTaxonomyInput } from "../lib/api/taxonomies.js";
import {
	fetchTaxonomyDef,
	fetchTermTranslations,
	fetchTerms,
	createTaxonomy,
	createTerm,
	createTermTranslation,
	reorderTerms,
	updateTerm,
	deleteTerm,
} from "../lib/api/taxonomies.js";
import { slugify } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { LocaleSwitcher, useI18nConfig } from "./LocaleSwitcher.js";
import { TranslationsPanel } from "./TranslationsPanel.js";

export function TaxonomyNotFoundMessage({ taxonomyName }: { taxonomyName: string }) {
	const { t } = useLingui();
	return <>{t`Taxonomy not found: ${taxonomyName}`}</>;
}

interface TaxonomyManagerProps {
	taxonomyName: string;
}

// Regex patterns for taxonomy name generation and validation (module-scoped per lint rules)
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;
const LEADING_TRAILING_UNDERSCORE_PATTERN = /^_|_$/g;
const TAXONOMY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Flatten tree to get all terms
 */
function flattenTerms(terms: TaxonomyTerm[]): TaxonomyTerm[] {
	return terms.flatMap((t) => [t, ...flattenTerms(t.children)]);
}

/**
 * Return valid parent candidates in tree order.
 *
 * The current term and its complete subtree are excluded while editing so a
 * parent change cannot create a taxonomy cycle.
 */
export function getAvailableParentTerms(
	terms: TaxonomyTerm[],
	currentTerm?: TaxonomyTerm,
): TaxonomyTerm[] {
	const flatTerms = flattenTerms(terms);
	if (!currentTerm) return flatTerms;

	const excludedIds = new Set([
		currentTerm.id,
		...flattenTerms(currentTerm.children).map((term) => term.id),
	]);
	return flatTerms.filter((term) => !excludedIds.has(term.id));
}

/** The translation group a term belongs to — what `parentId` and reorder ids hold. */
export function termGroup(term: TaxonomyTerm): string {
	return term.translationGroup ?? term.id;
}

/**
 * Whether a term is rendered in a group it isn't a member of.
 *
 * A child whose parent has no row in this locale is listed at the top level so
 * it isn't lost, but its position belongs to its parent's group. It can't be
 * moved from here, and it can't be named in a reorder of the group it's drawn in.
 */
export function isStranded(term: TaxonomyTerm, parentId: string | null): boolean {
	return parentId === null && !!term.parentId;
}

/**
 * Permute `movable` into the slots those same terms occupy in `rendered`,
 * leaving everything else where it is.
 *
 * Mirrors what the reorder endpoint does with the ids it's given, so the
 * optimistic list matches what comes back.
 */
export function reorderWithinSlots(
	rendered: TaxonomyTerm[],
	movable: TaxonomyTerm[],
	permuted: TaxonomyTerm[],
): TaxonomyTerm[] {
	const inGroup = new Set(movable);
	const next = [...rendered];
	let slot = 0;
	for (const [index, term] of rendered.entries()) {
		if (!inGroup.has(term)) continue;
		const replacement = permuted[slot++];
		if (replacement) next[index] = replacement;
	}
	return next;
}

/**
 * Replace one sibling group in a term tree with a reordered copy of itself.
 *
 * `parentId` is a translation group (what `term.parentId` holds), so it matches
 * the parent in whichever locale is on screen. `null` replaces the roots.
 */
export function replaceSiblingGroup(
	terms: TaxonomyTerm[],
	parentId: string | null,
	ordered: TaxonomyTerm[],
): TaxonomyTerm[] {
	if (parentId === null) return ordered;
	return terms.map((term) =>
		termGroup(term) === parentId
			? { ...term, children: ordered }
			: { ...term, children: replaceSiblingGroup(term.children, parentId, ordered) },
	);
}

interface TermRowCallbacks {
	onEdit: (term: TaxonomyTerm) => void;
	onDelete: (term: TaxonomyTerm) => void;
	onMove: (
		parentId: string | null,
		siblings: TaxonomyTerm[],
		movable: TaxonomyTerm[],
		term: TaxonomyTerm,
		direction: -1 | 1,
	) => void;
	onTranslate?: (term: TaxonomyTerm) => void;
	canTranslate: boolean;
}

/**
 * One sibling group's rows, in display order.
 *
 * The movable subset is worked out once for the whole group: each row needs it
 * to know whether its carets are live, and a move needs the same list to build
 * the order it sends.
 */
function TermGroup({
	siblings,
	parentId,
	level = 0,
	...callbacks
}: {
	siblings: TaxonomyTerm[];
	parentId: string | null;
	level?: number;
} & TermRowCallbacks) {
	const movable = siblings.filter((sibling) => !isStranded(sibling, parentId));
	const places = new Map(movable.map((term, index) => [term, index]));
	return (
		<>
			{siblings.map((term) => (
				<TermRow
					key={term.id}
					term={term}
					siblings={siblings}
					movable={movable}
					place={places.get(term) ?? -1}
					parentId={parentId}
					level={level}
					{...callbacks}
				/>
			))}
		</>
	);
}

/**
 * Term row component (recursive for hierarchy)
 *
 * `siblings` is the group the term is rendered from, in display order, and
 * `parentId` is that group's parent. Moving a term reorders that group and
 * never changes its parent.
 *
 * A term whose parent has no row in this locale is rendered at the top level so
 * it isn't lost, but it belongs to its parent's group — a group this locale
 * can't show. Its move buttons are disabled rather than silently addressing the
 * wrong group, and `place` is -1 because it holds no slot in the group it is
 * drawn in.
 */
function TermRow({
	term,
	siblings,
	movable,
	place,
	parentId,
	level = 0,
	onEdit,
	onDelete,
	onMove,
	onTranslate,
	canTranslate,
}: {
	term: TaxonomyTerm;
	siblings: TaxonomyTerm[];
	movable: TaxonomyTerm[];
	place: number;
	parentId: string | null;
	level?: number;
} & TermRowCallbacks) {
	const { t } = useLingui();
	const stranded = isStranded(term, parentId);
	return (
		<>
			<div className="flex items-center gap-4 py-2 px-4 hover:bg-kumo-tint/50">
				<div style={{ marginInlineStart: `${level * 1.5}rem` }} className="flex-1">
					<span className="font-medium">{term.label}</span>
					<span className="text-sm text-kumo-subtle ms-2">({term.slug})</span>
				</div>
				<div className="text-sm text-kumo-subtle">{term.count || 0}</div>
				<div className="flex gap-2">
					{/* The buttons inside are disabled and take no pointer events, so the
					    explanation has to hang off something that still receives hover. */}
					<span
						className="flex gap-2"
						title={
							stranded
								? t`${term.label} can't be moved here — its parent has no translation in this locale, so this list isn't the group it belongs to.`
								: undefined
						}
					>
						<Button
							variant="ghost"
							size="sm"
							aria-label={
								stranded
									? t`Move ${term.label} up — unavailable, its parent has no translation in this locale`
									: t`Move ${term.label} up`
							}
							disabled={stranded || place <= 0}
							onClick={() => onMove(parentId, siblings, movable, term, -1)}
						>
							<CaretUp className="w-4 h-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							aria-label={
								stranded
									? t`Move ${term.label} down — unavailable, its parent has no translation in this locale`
									: t`Move ${term.label} down`
							}
							disabled={stranded || place >= movable.length - 1}
							onClick={() => onMove(parentId, siblings, movable, term, 1)}
						>
							<CaretDown className="w-4 h-4" />
						</Button>
					</span>
					{canTranslate && onTranslate ? (
						<Button
							variant="ghost"
							size="sm"
							aria-label={t`Translate ${term.label}`}
							onClick={() => onTranslate(term)}
						>
							{t`Translate`}
						</Button>
					) : null}
					<Button
						variant="ghost"
						size="sm"
						aria-label={t`Edit ${term.label}`}
						onClick={() => onEdit(term)}
					>
						<Pencil className="w-4 h-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label={t`Delete ${term.label}`}
						onClick={() => onDelete(term)}
					>
						<Trash className="w-4 h-4" />
					</Button>
				</div>
			</div>
			<TermGroup
				siblings={term.children}
				parentId={termGroup(term)}
				level={level + 1}
				onEdit={onEdit}
				onDelete={onDelete}
				onMove={onMove}
				onTranslate={onTranslate}
				canTranslate={canTranslate}
			/>
		</>
	);
}

/**
 * Dialog to pick a target locale for creating a term translation.
 */
function TranslateTermDialog({
	term,
	taxonomyName,
	locales,
	activeLocale,
	isPending,
	error,
	onClose,
	onSubmit,
}: {
	term: TaxonomyTerm;
	taxonomyName: string;
	locales: string[];
	activeLocale: string | undefined;
	isPending: boolean;
	error: Error | null;
	onClose: () => void;
	onSubmit: (locale: string) => void;
}) {
	const { t } = useLingui();
	const otherLocales = locales.filter((l) => l !== activeLocale);
	const [selected, setSelected] = React.useState<string>(otherLocales[0] ?? "");

	return (
		<Dialog.Root
			open
			onOpenChange={(isOpen: boolean) => {
				if (!isOpen) onClose();
			}}
		>
			<Dialog className="p-6" size="sm">
				<div className="flex items-start justify-between gap-4 mb-4">
					<div>
						<Dialog.Title className="text-lg font-semibold">
							{t`Translate "${term.label}"`}
						</Dialog.Title>
						<Dialog.Description className="text-sm text-kumo-subtle">
							{t`Taxonomy: ${taxonomyName}`}
						</Dialog.Description>
					</div>
					<Dialog.Close
						render={(props) => (
							<Button {...props} variant="ghost" shape="square" aria-label={t`Close`}>
								<X className="h-4 w-4" />
							</Button>
						)}
					/>
				</div>
				<div className="space-y-4 py-2">
					<Select
						label={t`Target locale`}
						value={selected}
						onValueChange={(v) => setSelected(v ?? "")}
						items={Object.fromEntries(otherLocales.map((l) => [l, l.toUpperCase()]))}
					>
						{otherLocales.map((l) => (
							<Select.Option key={l} value={l}>
								{l.toUpperCase()}
							</Select.Option>
						))}
					</Select>
					<DialogError message={error ? error.message : null} />
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="outline" type="button" onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button
						type="button"
						disabled={!selected || isPending}
						onClick={() => onSubmit(selected)}
					>
						{isPending ? t`Translating...` : t`Translate`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Term form dialog
 */
function TermFormDialog({
	open,
	onClose,
	taxonomyName,
	taxonomyDef,
	term,
	allTerms,
	locale,
	i18n,
	onOpenTranslation,
}: {
	open: boolean;
	onClose: () => void;
	taxonomyName: string;
	taxonomyDef: TaxonomyDef;
	term?: TaxonomyTerm;
	allTerms: TaxonomyTerm[];
	locale?: string;
	i18n: { defaultLocale: string; locales: string[] } | null;
	onOpenTranslation?: (translatedTerm: { slug: string; locale: string }) => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [label, setLabel] = React.useState(term?.label || "");
	const [slug, setSlug] = React.useState(term?.slug || "");
	const [parentId, setParentId] = React.useState(term?.parentId || "");
	const [description, setDescription] = React.useState(term?.description || "");
	const [autoSlug, setAutoSlug] = React.useState(!term);
	const [error, setError] = React.useState<string | null>(null);

	// Sync form state when term prop changes (for edit mode)
	React.useEffect(() => {
		setLabel(term?.label || "");
		setSlug(term?.slug || "");
		setParentId(term?.parentId || "");
		setDescription(term?.description || "");
		setAutoSlug(!term);
		setError(null);
	}, [term]);

	// Auto-generate slug from label
	React.useEffect(() => {
		if (autoSlug && label) {
			setSlug(slugify(label));
		}
	}, [label, autoSlug]);

	const createMutation = useMutation({
		mutationFn: () =>
			createTerm(taxonomyName, {
				...(autoSlug ? {} : { slug }),
				label,
				parentId: parentId || undefined,
				description: description || undefined,
				locale,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			onClose();
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	const updateMutation = useMutation({
		mutationFn: () => {
			if (!term) throw new Error("No term to update");
			return updateTerm(
				taxonomyName,
				term.slug,
				{
					slug,
					label,
					parentId: parentId || undefined,
					description: description || undefined,
				},
				{ locale: term.locale ?? locale },
			);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			onClose();
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	// Translations list (only when editing an existing term and i18n is on).
	const { data: translationsData } = useQuery({
		queryKey: ["term-translations", taxonomyName, term?.id ?? null],
		queryFn: () => {
			if (!term) throw new Error("No term");
			return fetchTermTranslations(taxonomyName, term.slug, { locale: term.locale ?? locale });
		},
		enabled: !!term && !!i18n && i18n.locales.length > 1,
	});

	const translateMutation = useMutation({
		mutationFn: (targetLocale: string) => {
			if (!term) throw new Error("No term");
			return createTermTranslation(
				taxonomyName,
				term.slug,
				{ locale: targetLocale, label: term.label, slug: term.slug },
				{ locale: term.locale ?? locale },
			);
		},
		onSuccess: (translated) => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", taxonomyName] });
			void queryClient.invalidateQueries({ queryKey: ["term-translations", taxonomyName] });
			onClose();
			onOpenTranslation?.({ slug: translated.slug, locale: translated.locale });
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (term) {
			updateMutation.mutate();
		} else {
			createMutation.mutate();
		}
	};

	const availableParents = getAvailableParentTerms(allTerms, term);

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen: boolean) => {
				if (!isOpen) {
					setError(null);
					onClose();
				}
			}}
		>
			<Dialog className="p-6 max-h-[85vh] flex flex-col" size="lg">
				<form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
					<div className="flex items-start justify-between gap-4 mb-4">
						<div className="flex flex-col space-y-1.5">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								{term
									? t`Edit ${taxonomyDef.labelSingular || t`Term`}`
									: t`Add ${taxonomyDef.labelSingular || t`Term`}`}
							</Dialog.Title>
							<Dialog.Description className="text-sm text-kumo-subtle">
								{term
									? t`Update the ${taxonomyDef.labelSingular?.toLowerCase() || "term"} details`
									: t`Create a new ${taxonomyDef.labelSingular?.toLowerCase() || "term"}`}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button
									{...props}
									variant="ghost"
									shape="square"
									aria-label={t`Close`}
									className="absolute end-4 top-4"
								>
									<X className="h-4 w-4" />
									<span className="sr-only">{t`Close`}</span>
								</Button>
							)}
						/>
					</div>

					<div className="space-y-4 py-4 flex-1 overflow-y-auto -mx-1 px-1 min-h-0">
						<Input
							label={t`Name`}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder={t`News`}
							required
						/>

						<div>
							<Input
								label={t`Slug`}
								value={slug}
								onChange={(e) => {
									setSlug(e.target.value);
									setAutoSlug(false);
								}}
								placeholder="news"
								required
							/>
							<p className="text-sm text-kumo-subtle mt-1">
								{t`Auto-generated from name (you can edit)`}
							</p>
						</div>

						{taxonomyDef.hierarchical && (
							<Select
								label={t`Parent`}
								value={parentId}
								onValueChange={(v) => setParentId(v ?? "")}
								items={{
									"": t`None (top level)`,
									...Object.fromEntries(
										availableParents.map((parentTerm) => [
											parentTerm.translationGroup ?? parentTerm.id,
											parentTerm.label,
										]),
									),
								}}
							>
								<Select.Option value="">{t`None (top level)`}</Select.Option>
								{availableParents.map((parentTerm) => (
									<Select.Option
										key={parentTerm.id}
										value={parentTerm.translationGroup ?? parentTerm.id}
									>
										{parentTerm.label}
									</Select.Option>
								))}
							</Select>
						)}

						<InputArea
							label={t`Description (optional)`}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder={t`Optional description`}
							rows={3}
						/>

						<DialogError
							message={
								error ||
								getMutationError(createMutation.error) ||
								getMutationError(updateMutation.error) ||
								getMutationError(translateMutation.error)
							}
						/>

						{term && i18n && i18n.locales.length > 1 ? (
							<div className="pt-4 border-t">
								<TranslationsPanel
									locales={i18n.locales}
									defaultLocale={i18n.defaultLocale}
									currentLocale={term.locale}
									translations={translationsData?.translations ?? []}
									onOpen={(tr) => {
										onClose();
										onOpenTranslation?.({ slug: term.slug, locale: tr.locale });
									}}
									onCreate={(target) => translateMutation.mutate(target)}
									pendingLocale={
										translateMutation.isPending ? (translateMutation.variables ?? null) : null
									}
								/>
							</div>
						) : null}
					</div>

					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Button type="button" variant="outline" onClick={onClose}>
							{t`Cancel`}
						</Button>
						<Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
							{createMutation.isPending || updateMutation.isPending
								? t`Saving...`
								: term
									? t`Update`
									: t`Create`}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Create Taxonomy dialog
 */
function CreateTaxonomyDialog({
	open,
	onClose,
	onCreated,
}: {
	open: boolean;
	onClose: () => void;
	onCreated: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [name, setName] = React.useState("");
	const [label, setLabel] = React.useState("");
	const [hierarchical, setHierarchical] = React.useState(false);
	const [selectedCollections, setSelectedCollections] = React.useState<string[]>([]);
	const [autoName, setAutoName] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const collectionEntries = manifest
		? Object.entries(manifest.collections).map(([slug, config]) => ({
				slug,
				label: config.label,
			}))
		: [];

	// Auto-generate name from label
	React.useEffect(() => {
		if (autoName && label) {
			setName(
				label
					.toLowerCase()
					.replace(NON_ALPHANUMERIC_PATTERN, "_")
					.replace(LEADING_TRAILING_UNDERSCORE_PATTERN, ""),
			);
		}
	}, [label, autoName]);

	const createMutation = useMutation({
		mutationFn: (input: CreateTaxonomyInput) => createTaxonomy(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-defs"] });
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-def"] });
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			onCreated();
			resetForm();
		},
	});

	const resetForm = () => {
		setName("");
		setLabel("");
		setHierarchical(false);
		setSelectedCollections([]);
		setAutoName(true);
		setError(null);
		createMutation.reset();
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!name || !label) {
			setError(t`Name and label are required`);
			return;
		}

		if (!TAXONOMY_NAME_PATTERN.test(name)) {
			setError(
				t`Name must start with a letter and contain only lowercase letters, numbers, and underscores`,
			);
			return;
		}

		createMutation.mutate({
			name,
			label,
			hierarchical,
			collections: selectedCollections,
		});
	};

	const toggleCollection = (slug: string) => {
		setSelectedCollections((prev) =>
			prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
		);
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen: boolean) => {
				if (!isOpen) {
					resetForm();
					onClose();
				}
			}}
		>
			<Dialog className="p-6" size="lg">
				<form onSubmit={handleSubmit}>
					<div className="flex items-start justify-between gap-4 mb-4">
						<div className="flex flex-col space-y-1.5">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								{t`Create Taxonomy`}
							</Dialog.Title>
							<Dialog.Description className="text-sm text-kumo-subtle">
								{t`Define a new taxonomy for classifying content`}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button
									{...props}
									variant="ghost"
									shape="square"
									aria-label={t`Close`}
									className="absolute end-4 top-4"
								>
									<X className="h-4 w-4" />
									<span className="sr-only">{t`Close`}</span>
								</Button>
							)}
						/>
					</div>

					<div className="space-y-4 py-4">
						<Input
							label={t`Label`}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder={t`Genres`}
							required
						/>

						<div>
							<Input
								label={t`Name`}
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									setAutoName(false);
								}}
								placeholder="genre"
								required
								pattern="[a-z][a-z0-9_]*"
								title={t`Lowercase letters, numbers, and underscores only, starting with a letter`}
							/>
							<p className="text-xs text-kumo-subtle mt-1">
								{t`Used as the identifier. Lowercase letters, numbers, and underscores only.`}
							</p>
						</div>

						<Checkbox
							label={t`Hierarchical (like categories, with parent/child relationships)`}
							checked={hierarchical}
							onCheckedChange={(checked) => setHierarchical(checked)}
						/>

						{collectionEntries.length > 0 && (
							<div>
								<label className="text-sm font-medium">{t`Collections`}</label>
								<p className="text-xs text-kumo-subtle mb-2">
									{t`Which content types can use this taxonomy`}
								</p>
								<div className="border rounded-md p-2 space-y-1">
									{collectionEntries.map(({ slug, label: collLabel }) => (
										<div key={slug} className="py-1 px-2 hover:bg-kumo-tint/50 rounded">
											<Checkbox
												checked={selectedCollections.includes(slug)}
												onCheckedChange={() => toggleCollection(slug)}
												label={<span className="text-sm">{collLabel}</span>}
											/>
										</div>
									))}
								</div>
							</div>
						)}

						<DialogError message={error || getMutationError(createMutation.error)} />
					</div>

					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								resetForm();
								onClose();
							}}
						>
							{t`Cancel`}
						</Button>
						<Button type="submit" disabled={createMutation.isPending}>
							{createMutation.isPending ? t`Creating...` : t`Create Taxonomy`}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Main TaxonomyManager component
 */
export function TaxonomyManager({ taxonomyName }: TaxonomyManagerProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [formOpen, setFormOpen] = React.useState(false);
	const [editingTerm, setEditingTerm] = React.useState<TaxonomyTerm | undefined>();
	const [deleteTarget, setDeleteTarget] = React.useState<TaxonomyTerm | null>(null);
	const [createTaxonomyOpen, setCreateTaxonomyOpen] = React.useState(false);
	const [translateTarget, setTranslateTarget] = React.useState<TaxonomyTerm | null>(null);

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const i18n = useI18nConfig(manifest);
	const [activeLocale, setActiveLocale] = React.useState<string | undefined>(undefined);
	React.useEffect(() => {
		if (i18n && !activeLocale) setActiveLocale(i18n.defaultLocale);
	}, [i18n, activeLocale]);

	// The taxonomy definition is looked up without filtering by locale — the
	// def is primarily structural ("does this taxonomy exist, is it
	// hierarchical, which collections use it"). Label translations exist per
	// locale but are not required for the page to render.
	const { data: taxonomyDef, isLoading: defLoading } = useQuery({
		queryKey: ["taxonomy-def", taxonomyName],
		queryFn: () => fetchTaxonomyDef(taxonomyName),
	});

	// The count mode belongs in the key: the editor's taxonomy picker reads the
	// same endpoint without counts, and this page renders them.
	const termsQueryKey = ["taxonomy-terms", taxonomyName, activeLocale, { includeCounts: true }];
	const { data: terms = [], isLoading: termsLoading } = useQuery({
		queryKey: termsQueryKey,
		queryFn: () => fetchTerms(taxonomyName, { locale: activeLocale }),
	});

	const deleteMutation = useMutation({
		mutationFn: (term: TaxonomyTerm) =>
			deleteTerm(taxonomyName, term.slug, { locale: activeLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", taxonomyName] });
			setDeleteTarget(null);
			toastManager.add({ title: t`Term deleted` });
		},
	});

	const reorderMutationKey = ["taxonomy-terms-reorder", taxonomyName];
	const reorderMutation = useMutation({
		mutationKey: reorderMutationKey,
		// Each body is an absolute order, so queued moves have to land in click
		// order; a shared scope serializes them.
		scope: { id: `taxonomy-reorder:${taxonomyName}` },
		mutationFn: ({ parentId, ids }: { parentId: string | null; ids: string[] }) =>
			reorderTerms(taxonomyName, { parentId, ids }),
		onError: (error: Error) => {
			toastManager.add({ title: t`Error`, description: error.message, type: "error" });
		},
		onSettled: () => {
			// The count includes this mutation, so >1 means another move is queued
			// behind it and refetching now would serve a stale order.
			if (queryClient.isMutating({ mutationKey: reorderMutationKey }) > 1) return;
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", taxonomyName] });
		},
	});

	const handleMove = (
		parentId: string | null,
		siblings: TaxonomyTerm[],
		movable: TaxonomyTerm[],
		term: TaxonomyTerm,
		direction: -1 | 1,
	) => {
		const from = movable.indexOf(term);
		const to = from + direction;
		const moving = movable[from];
		const displaced = movable[to];
		if (!moving || !displaced) return;

		const permuted = movable.map((sibling, index) =>
			index === from ? displaced : index === to ? moving : sibling,
		);
		const reordered = reorderWithinSlots(siblings, movable, permuted);
		queryClient.setQueryData(termsQueryKey, (current: TaxonomyTerm[] | undefined) =>
			current ? replaceSiblingGroup(current, parentId, reordered) : current,
		);
		reorderMutation.mutate({ parentId, ids: permuted.map(termGroup) });
	};

	const translateMutation = useMutation({
		mutationFn: ({ term, locale }: { term: TaxonomyTerm; locale: string }) =>
			createTermTranslation(
				taxonomyName,
				term.slug,
				{ locale, label: term.label, slug: term.slug },
				{ locale: activeLocale },
			),
		onSuccess: (term) => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", taxonomyName] });
			setTranslateTarget(null);
			setActiveLocale(term.locale);
			toastManager.add({
				title: t`Translation created`,
				description: t`Term "${term.label}" created in ${term.locale.toUpperCase()}.`,
			});
		},
	});

	const handleEdit = (term: TaxonomyTerm) => {
		setEditingTerm(term);
		setFormOpen(true);
	};

	const handleDelete = (term: TaxonomyTerm) => {
		setDeleteTarget(term);
	};

	const handleCloseForm = () => {
		setFormOpen(false);
		setEditingTerm(undefined);
	};

	if (defLoading) {
		return <div>{t`Loading...`}</div>;
	}

	if (!taxonomyDef) {
		return (
			<div>
				<TaxonomyNotFoundMessage taxonomyName={taxonomyName} />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4 flex-wrap">
				<div>
					<h1 className="text-2xl font-semibold leading-tight">{taxonomyDef.label}</h1>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Manage ${taxonomyDef.label.toLowerCase()} for ${taxonomyDef.collections.join(", ")}`}
					</p>
				</div>
				<div className="flex gap-2 items-center">
					{i18n && activeLocale ? (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={setActiveLocale}
						/>
					) : null}
					<Button variant="outline" icon={<Plus />} onClick={() => setCreateTaxonomyOpen(true)}>
						{t`New Taxonomy`}
					</Button>
					<Button icon={<Plus />} onClick={() => setFormOpen(true)}>
						{t`Add ${taxonomyDef.labelSingular || t`Term`}`}
					</Button>
				</div>
			</div>

			<div className="border rounded-lg">
				<div className="flex items-center gap-4 py-2 px-4 border-b bg-kumo-tint/50 font-medium">
					<div className="flex-1">{t`Name`}</div>
					<div className="w-16 text-center">{t`Count`}</div>
					<div className="w-24 text-center">{t`Actions`}</div>
				</div>

				{termsLoading ? (
					<div className="p-8 text-center text-kumo-subtle">{t`Loading terms...`}</div>
				) : terms.length === 0 ? (
					<div className="p-8 text-center text-kumo-subtle">
						{t`No ${taxonomyDef.label.toLowerCase()} yet. Create one to get started.`}
					</div>
				) : (
					<div className="divide-y divide-kumo-line">
						<TermGroup
							siblings={terms}
							parentId={null}
							onEdit={handleEdit}
							onDelete={handleDelete}
							onMove={handleMove}
							onTranslate={setTranslateTarget}
							canTranslate={!!i18n && !!activeLocale && i18n.locales.length > 1}
						/>
					</div>
				)}
			</div>

			<TermFormDialog
				open={formOpen}
				onClose={handleCloseForm}
				taxonomyName={taxonomyName}
				taxonomyDef={taxonomyDef}
				term={editingTerm}
				allTerms={terms}
				locale={activeLocale}
				i18n={i18n}
				onOpenTranslation={(tr) => setActiveLocale(tr.locale)}
			/>

			{i18n && translateTarget ? (
				<TranslateTermDialog
					term={translateTarget}
					taxonomyName={taxonomyName}
					locales={i18n.locales}
					activeLocale={activeLocale}
					isPending={translateMutation.isPending}
					error={translateMutation.error}
					onClose={() => {
						setTranslateTarget(null);
						translateMutation.reset();
					}}
					onSubmit={(locale) => translateMutation.mutate({ term: translateTarget, locale })}
				/>
			) : null}

			<ConfirmDialog
				open={!!deleteTarget}
				onClose={() => {
					setDeleteTarget(null);
					deleteMutation.reset();
				}}
				title={t`Delete ${taxonomyDef.labelSingular || "Term"}?`}
				description={
					<>{t`This will permanently delete "${deleteTarget?.label}" and remove it from all content.`}</>
				}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
			/>

			<CreateTaxonomyDialog
				open={createTaxonomyOpen}
				onClose={() => setCreateTaxonomyOpen(false)}
				onCreated={() => {
					setCreateTaxonomyOpen(false);
					toastManager.add({ title: t`Taxonomy created` });
				}}
			/>
		</div>
	);
}
