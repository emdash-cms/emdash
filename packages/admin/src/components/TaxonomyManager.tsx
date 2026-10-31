/**
 * Taxonomy Terms Manager
 *
 * Provides UI for managing taxonomy terms (categories, tags, custom taxonomies).
 * Shows hierarchical structure for categories, flat list for tags.
 */

import {
	Button,
	Checkbox,
	DropdownMenu,
	Input,
	InputArea,
	LayerDialog,
	Select,
	useKumoToastManager,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowUp,
	DotsThree,
	MagnifyingGlass,
	Plus,
	Pencil,
	StackSimple,
	Tag,
	Translate,
	Trash,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { ApiResponseError, fetchManifest } from "../lib/api/client.js";
import type {
	TaxonomyTerm,
	TaxonomyDef,
	CreateTaxonomyInput,
	CreateTermInput,
	UpdateTermInput,
} from "../lib/api/taxonomies.js";
import {
	fetchTaxonomyDef,
	fetchTermTranslations,
	fetchTerms,
	createTaxonomy,
	createTerm,
	createTermTranslation,
	reorderTerms,
	updateTerm,
	deleteTaxonomy,
	deleteTerm,
} from "../lib/api/taxonomies.js";
import { guardUnsavedInput, revealErrors, useSingleFlight } from "../lib/dialog-form.js";
import { inlineLabel } from "../lib/inline-label.js";
import { slugify, slugifyIdentifier } from "../lib/utils";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { BulkTagDialog } from "./BulkTagDialog.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DataTable, DataTableMessage, RowActionsMenu, RowTitleButton } from "./DataTable.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { DialogSection } from "./DialogSection.js";
import { HelpLabel, HelpTooltip } from "./FieldHelpLabel.js";
import { LocaleSwitcher, useI18nConfig } from "./LocaleSwitcher.js";
import { TableToolbarSearch } from "./TableToolbar.js";
import { TranslationsPanel } from "./TranslationsPanel.js";

export function TaxonomyNotFoundMessage({ taxonomyName }: { taxonomyName: string }) {
	const { t } = useLingui();
	return <>{t`Taxonomy not found: ${taxonomyName}`}</>;
}

interface TaxonomyManagerProps {
	taxonomyName: string;
	/** Called after the taxonomy itself is deleted, so the host can route away. */
	onDeleted?: () => void;
}

// Regex patterns for taxonomy name generation and validation (module-scoped per lint rules)
const TAXONOMY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const TAXONOMY_NAME_MAX_LENGTH = 63;
const TAXONOMY_LABEL_MAX_LENGTH = 200;

function isConflict(error: unknown): boolean {
	return error instanceof ApiResponseError && error.code === "CONFLICT";
}

type TermField = "label" | "slug";

function termProblems(state: {
	label: string;
	slug: string;
	autoSlug: boolean;
}): Partial<Record<TermField, MessageDescriptor>> {
	const problems: Partial<Record<TermField, MessageDescriptor>> = {};
	const labelGiven = Boolean(state.label.trim());
	if (!labelGiven) problems.label = msg`Enter a name.`;
	// An untouched slug fills in from the name, and the missing name already carries the error.
	if (!state.slug && (!state.autoSlug || labelGiven)) problems.slug = msg`Enter a slug.`;
	return problems;
}

type TaxonomyField = "label" | "name";

function taxonomyProblems(state: {
	label: string;
	name: string;
	autoName: boolean;
}): Partial<Record<TaxonomyField, MessageDescriptor>> {
	const problems: Partial<Record<TaxonomyField, MessageDescriptor>> = {};
	const labelGiven = Boolean(state.label.trim());
	if (!labelGiven) problems.label = msg`Enter a label.`;
	else if (state.label.length > TAXONOMY_LABEL_MAX_LENGTH) {
		problems.label = msg`Use 200 characters or fewer.`;
	}
	if (!state.name) {
		if (!state.autoName) problems.name = msg`Enter a name.`;
		else if (labelGiven) {
			problems.name = msg`A name cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.`;
		}
	} else if (!TAXONOMY_NAME_PATTERN.test(state.name)) {
		problems.name = msg`Use lowercase letters, numbers, and underscores, starting with a letter.`;
	} else if (state.name.length > TAXONOMY_NAME_MAX_LENGTH) {
		problems.name = msg`Use 63 characters or fewer.`;
	}
	return problems;
}

/**
 * Flatten tree to get all terms
 */
function flattenTerms(terms: TaxonomyTerm[]): TaxonomyTerm[] {
	return terms.flatMap((t) => [t, ...flattenTerms(t.children)]);
}

const NUMERIC_SUFFIX_PATTERN = /^\d+$/;

/**
 * The slug the server's `generateUniqueSlug` picks for `label` among `terms`:
 * the label's slug, or that slug plus one more than the highest numeric suffix
 * in use. Term slugs are unique per taxonomy and locale, not per parent.
 */
function freeTermSlug(label: string, terms: TaxonomyTerm[]): string {
	const base = slugify(label);
	const slugs = flattenTerms(terms).map((term) => term.slug);
	if (!slugs.includes(base)) return base;
	const prefix = `${base}-`;
	let highest = 0;
	for (const slug of slugs) {
		const suffix = slug.startsWith(prefix) ? slug.slice(prefix.length) : "";
		if (NUMERIC_SUFFIX_PATTERN.test(suffix)) {
			highest = Math.max(highest, Number.parseInt(suffix, 10));
		}
	}
	return `${base}-${highest + 1}`;
}

function canonicalSearchLocale(locale: string): string {
	try {
		return Intl.getCanonicalLocales(locale)[0] ?? "en";
	} catch {
		return "en";
	}
}

function findMatchingTagIds(
	terms: TaxonomyTerm[],
	labelSearch: string,
	slugSearch: string,
	locale: string,
) {
	const visibleIds = new Set<string>();
	let matchCount = 0;
	const visit = (term: TaxonomyTerm): boolean => {
		let hasMatchingChild = false;
		for (const child of term.children) {
			if (visit(child)) hasMatchingChild = true;
		}
		const matches =
			term.label.toLocaleLowerCase(locale).includes(labelSearch) ||
			term.slug.toLowerCase().includes(slugSearch);
		if (matches) matchCount++;
		if (matches || hasMatchingChild) visibleIds.add(term.id);
		return matches || hasMatchingChild;
	};
	for (const term of terms) visit(term);
	return { visibleIds, matchCount };
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
 * to know whether its Move items show and are live, and a move needs the same
 * list to build the order it sends.
 */
function TermGroup({
	siblings,
	parentId,
	level = 0,
	searchActive = false,
	visibleIds,
	...callbacks
}: {
	siblings: TaxonomyTerm[];
	parentId: string | null;
	level?: number;
	searchActive?: boolean;
	visibleIds?: Set<string>;
} & TermRowCallbacks) {
	const movable = siblings.filter((sibling) => !isStranded(sibling, parentId));
	const places = new Map(movable.map((term, index) => [term, index]));
	return (
		<>
			{siblings
				.filter((term) => !visibleIds || visibleIds.has(term.id))
				.map((term) => (
					<TermRow
						key={term.id}
						term={term}
						siblings={siblings}
						movable={movable}
						place={places.get(term) ?? -1}
						parentId={parentId}
						level={level}
						searchActive={searchActive}
						visibleIds={visibleIds}
						{...callbacks}
					/>
				))}
		</>
	);
}

/**
 * A term's row, followed by its children's rows.
 *
 * `siblings` is the group the term is rendered from, in display order, and
 * `parentId` is that group's parent. Moving a term reorders that group and
 * never changes its parent.
 *
 * A term whose parent has no row in this locale is rendered at the top level so
 * it isn't lost, but it belongs to its parent's group — a group this locale
 * can't show. Its Move items are disabled rather than silently addressing the
 * wrong group, and `place` is -1 because it holds no slot in the group it is
 * drawn in.
 */
function TermRow({
	term,
	siblings,
	movable,
	place,
	parentId,
	level,
	searchActive,
	visibleIds,
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
	level: number;
	searchActive: boolean;
	visibleIds?: Set<string>;
} & TermRowCallbacks) {
	const { t } = useLingui();
	const strandedReasonId = React.useId();
	const stranded = isStranded(term, parentId);
	const showMoves = !searchActive && (stranded || movable.length > 1);
	return (
		<>
			<tr>
				<td>
					{/* Deeper levels step in less, so a deep tree keeps its actions menu inside a narrow table. */}
					<div
						className="ps-[calc(min(var(--depth),6)*1.5rem+max(var(--depth)-6,0)*0.5rem)] @max-md:ps-[calc(min(var(--depth),4)*0.75rem+max(var(--depth)-4,0)*0.25rem)]"
						style={{ "--depth": level } as React.CSSProperties}
					>
						<RowTitleButton
							dir="auto"
							aria-label={t`Edit ${term.label}`}
							onClick={() => onEdit(term)}
						>
							{term.label}
						</RowTitleButton>
						<div className="text-xs text-kumo-subtle wrap-anywhere">
							<bdi dir="ltr">/{term.slug}</bdi>
						</div>
					</div>
				</td>
				<td className="text-end text-sm tabular-nums">{term.count ?? 0}</td>
				<td className="text-end">
					<RowActionsMenu label={t`Actions for ${term.label}`}>
						<DropdownMenu.Item
							icon={<Pencil className="size-4" aria-hidden="true" />}
							onClick={() => onEdit(term)}
						>
							{t`Edit`}
						</DropdownMenu.Item>
						{showMoves && (
							<DropdownMenu.Group>
								{stranded && (
									<DropdownMenu.Label
										id={strandedReasonId}
										className="max-w-60 px-2! text-sm font-normal text-pretty text-kumo-subtle"
									>
										{t`${term.label} can't be moved here — its parent has no translation in this locale, so this list isn't the group it belongs to.`}
									</DropdownMenu.Label>
								)}
								<DropdownMenu.Item
									icon={<ArrowUp className="size-4" aria-hidden="true" />}
									aria-describedby={stranded ? strandedReasonId : undefined}
									disabled={stranded || place <= 0}
									onClick={() => onMove(parentId, siblings, movable, term, -1)}
								>
									{t`Move up`}
								</DropdownMenu.Item>
								<DropdownMenu.Item
									icon={<ArrowDown className="size-4" aria-hidden="true" />}
									aria-describedby={stranded ? strandedReasonId : undefined}
									disabled={stranded || place >= movable.length - 1}
									onClick={() => onMove(parentId, siblings, movable, term, 1)}
								>
									{t`Move down`}
								</DropdownMenu.Item>
							</DropdownMenu.Group>
						)}
						{canTranslate && onTranslate && (
							<DropdownMenu.Item
								icon={<Translate className="size-4" aria-hidden="true" />}
								onClick={() => onTranslate(term)}
							>
								{t`Translate`}
							</DropdownMenu.Item>
						)}
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							variant="danger"
							icon={<Trash className="size-4" aria-hidden="true" />}
							aria-label={t`Delete ${term.label}`}
							onClick={() => onDelete(term)}
						>
							{t`Delete`}
						</DropdownMenu.Item>
					</RowActionsMenu>
				</td>
			</tr>
			<TermGroup
				siblings={term.children}
				parentId={termGroup(term)}
				level={level + 1}
				searchActive={searchActive}
				visibleIds={visibleIds}
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
		<LayerDialog.Root
			open
			onOpenChange={(isOpen: boolean) => {
				if (!isOpen) onClose();
			}}
			dismissDisabled={isPending}
		>
			<LayerDialog.Content size="sm">
				<LayerDialog.Title>{t`Translate "${term.label}"`}</LayerDialog.Title>
				<LayerDialog.Description>{t`Taxonomy: ${taxonomyName}`}</LayerDialog.Description>
				<LayerDialog.Body>
					<div className="grid gap-5">
						<Select
							label={t`Target locale`}
							className="w-full"
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
						<DialogError message={getMutationError(error)} />
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action disabled={!selected || isPending} onClick={() => onSubmit(selected)}>
						{isPending ? t`Translating...` : t`Translate`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
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
	const { t, i18n: lingui } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const formId = React.useId();
	const formRef = React.useRef<HTMLFormElement>(null);
	const [label, setLabel] = React.useState(term?.label || "");
	const [slug, setSlug] = React.useState(term?.slug || "");
	const [parentId, setParentId] = React.useState(term?.parentId || "");
	const [description, setDescription] = React.useState(term?.description || "");
	const [autoSlug, setAutoSlug] = React.useState(!term);
	const [submitted, setSubmitted] = React.useState(false);
	const [takenSlug, setTakenSlug] = React.useState<string | null>(null);

	// Auto-generate slug from label
	const generatedSlug = label.trim() ? freeTermSlug(label, allTerms) : "";
	React.useEffect(() => {
		if (autoSlug) setSlug(generatedSlug);
	}, [generatedSlug, autoSlug]);

	const showTakenSlug = (error: unknown, sentSlug: string | undefined) => {
		if (!isConflict(error) || sentSlug === undefined) return;
		revealErrors(formRef.current, () => {
			setSubmitted(true);
			setTakenSlug(sentSlug);
		});
	};

	const createMutation = useMutation({
		mutationFn: (input: CreateTermInput) => createTerm(taxonomyName, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			onClose();
			toastManager.add({ title: t`Term created` });
		},
		onError: (error, input) => showTakenSlug(error, input.slug),
	});
	const submitCreate = useSingleFlight((input: CreateTermInput) =>
		createMutation.mutateAsync(input),
	);

	const updateMutation = useMutation({
		mutationFn: (input: UpdateTermInput) => {
			if (!term) throw new Error("No term to update");
			return updateTerm(taxonomyName, term.slug, input, { locale: term.locale ?? locale });
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			onClose();
			toastManager.add({ title: t`Term updated` });
		},
		onError: (error, input) => showTakenSlug(error, input.slug),
	});
	const submitUpdate = useSingleFlight((input: UpdateTermInput) =>
		updateMutation.mutateAsync(input),
	);

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
	});

	React.useEffect(() => {
		if (!open) return;
		setLabel(term?.label || "");
		setSlug(term?.slug || "");
		setParentId(term?.parentId || "");
		setDescription(term?.description || "");
		setAutoSlug(!term);
		setSubmitted(false);
		setTakenSlug(null);
		createMutation.reset();
		updateMutation.reset();
		translateMutation.reset();
	}, [open, term, createMutation.reset, updateMutation.reset, translateMutation.reset]);

	const saving = createMutation.isPending || updateMutation.isPending;
	const busy = saving || translateMutation.isPending;
	const dirty = term
		? label !== term.label ||
			slug !== term.slug ||
			parentId !== (term.parentId || "") ||
			description !== (term.description || "")
		: label !== "" || slug !== "" || parentId !== "" || description !== "";

	const problems = termProblems({ label, slug, autoSlug });
	if (takenSlug !== null && slug === takenSlug) {
		problems.slug = msg`Another term already uses this slug. Enter a different one.`;
	}
	const errors = submitted ? problems : {};

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (busy) return;
		if (Object.keys(problems).length > 0) {
			revealErrors(e.currentTarget, () => setSubmitted(true));
			return;
		}
		if (term) {
			submitUpdate({ slug, label, parentId: parentId || undefined, description });
		} else {
			submitCreate({
				slug,
				label,
				parentId: parentId || undefined,
				description: description || undefined,
				locale,
			});
		}
	};

	const availableParents = getAvailableParentTerms(allTerms, term);

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(dirty, (isOpen) => {
				if (!isOpen) onClose();
			})}
			dismissDisabled={busy}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>
					{term
						? t`Edit ${taxonomyDef.labelSingular || t`Term`}`
						: t`Add ${taxonomyDef.labelSingular || t`Term`}`}
				</LayerDialog.Title>
				<LayerDialog.Description>
					{term
						? t`Update the ${inlineLabel(taxonomyDef.labelSingular || t`Term`, lingui.locale)} details`
						: t`Create a new ${inlineLabel(taxonomyDef.labelSingular || t`Term`, lingui.locale)}`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<form ref={formRef} id={formId} noValidate onSubmit={handleSubmit} className="grid gap-5">
						<Input
							label={t`Name`}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder={t`News`}
							required
							error={errors.label && t(errors.label)}
							aria-invalid={errors.label ? true : undefined}
						/>

						<Input
							dir="ltr"
							label={
								<span className="inline-flex items-center gap-1.5">
									{t`Slug`}
									<HelpTooltip
										help={t`Auto-generated from name (you can edit)`}
										ariaLabel={t`How is the slug generated?`}
										side="right"
										size="sm"
									/>
								</span>
							}
							aria-label={t`Slug`}
							className="w-full"
							value={slug}
							onChange={(e) => {
								setSlug(e.target.value);
								setAutoSlug(false);
							}}
							placeholder="news"
							required
							error={errors.slug && t(errors.slug)}
							aria-invalid={errors.slug ? true : undefined}
						/>

						{taxonomyDef.hierarchical && (
							<Select
								label={t`Parent`}
								className="w-full"
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
								getMutationError(isConflict(createMutation.error) ? null : createMutation.error) ||
								getMutationError(isConflict(updateMutation.error) ? null : updateMutation.error) ||
								getMutationError(translateMutation.error)
							}
						/>

						{term && i18n && i18n.locales.length > 1 ? (
							<div className="border-t border-kumo-line pt-5">
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
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={busy}>
						{saving ? t`Saving...` : term ? t`Update` : t`Create`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
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
	const formId = React.useId();
	const formRef = React.useRef<HTMLFormElement>(null);
	const [name, setName] = React.useState("");
	const [label, setLabel] = React.useState("");
	const [hierarchical, setHierarchical] = React.useState(false);
	const [selectedCollections, setSelectedCollections] = React.useState<string[]>([]);
	const [autoName, setAutoName] = React.useState(true);
	const [submitted, setSubmitted] = React.useState(false);
	const [takenName, setTakenName] = React.useState<string | null>(null);

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
			setName(slugifyIdentifier(label));
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
		onError: (error, input) => {
			if (!isConflict(error)) return;
			revealErrors(formRef.current, () => {
				setSubmitted(true);
				setTakenName(input.name);
			});
		},
	});
	const submitCreate = useSingleFlight((input: CreateTaxonomyInput) =>
		createMutation.mutateAsync(input),
	);

	const resetForm = () => {
		setName("");
		setLabel("");
		setHierarchical(false);
		setSelectedCollections([]);
		setAutoName(true);
		setSubmitted(false);
		setTakenName(null);
		createMutation.reset();
	};

	const problems = taxonomyProblems({ label, name, autoName });
	if (takenName !== null && name === takenName) {
		problems.name = msg`Another taxonomy already uses this name. Enter a different one.`;
	}
	const errors = submitted ? problems : {};
	// Before the first submit, the name that can't be generated is explained, not flagged.
	const nameHelp =
		!submitted && autoName && label.trim() && !name
			? t`A name cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.`
			: undefined;
	const dirty = label !== "" || name !== "" || hierarchical || selectedCollections.length > 0;

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (createMutation.isPending) return;
		if (Object.keys(problems).length > 0) {
			revealErrors(e.currentTarget, () => setSubmitted(true));
			return;
		}
		submitCreate({
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
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(dirty, (isOpen) => {
				if (!isOpen) {
					resetForm();
					onClose();
				}
			})}
			dismissDisabled={createMutation.isPending}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{t`Create Taxonomy`}</LayerDialog.Title>
				<LayerDialog.Description>
					{t`Define a new taxonomy for classifying content`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<form ref={formRef} id={formId} noValidate onSubmit={handleSubmit} className="grid gap-5">
						<Input
							label={t`Label`}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder={t`Genres`}
							required
							error={errors.label && t(errors.label)}
							aria-invalid={errors.label ? true : undefined}
						/>

						<Input
							dir="ltr"
							label={
								<HelpLabel
									help={t`Used as the identifier. Lowercase letters, numbers, and underscores only.`}
								>
									{t`Name`}
								</HelpLabel>
							}
							aria-label={t`Name`}
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setAutoName(false);
							}}
							placeholder="genre"
							required
							description={nameHelp}
							error={errors.name && t(errors.name)}
							aria-invalid={errors.name ? true : undefined}
						/>

						<Checkbox
							label={t`Hierarchical (like categories, with parent/child relationships)`}
							checked={hierarchical}
							onCheckedChange={(checked) => setHierarchical(checked)}
						/>

						{collectionEntries.length > 0 && (
							<DialogSection
								title={t`Collections`}
								help={t`Which content types can use this taxonomy`}
							>
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
							</DialogSection>
						)}

						<DialogError
							message={
								isConflict(createMutation.error) ? null : getMutationError(createMutation.error)
							}
						/>
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={createMutation.isPending}>
						{createMutation.isPending ? t`Creating...` : t`Create Taxonomy`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

/**
 * Main TaxonomyManager component
 */
export function TaxonomyManager({ taxonomyName, onDeleted }: TaxonomyManagerProps) {
	const { t, i18n: lingui } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [formOpen, setFormOpen] = React.useState(false);
	const [editingTerm, setEditingTerm] = React.useState<TaxonomyTerm | undefined>();
	const [deleteTarget, setDeleteTarget] = React.useState<TaxonomyTerm | null>(null);
	const [createTaxonomyOpen, setCreateTaxonomyOpen] = React.useState(false);
	const [deleteTaxonomyOpen, setDeleteTaxonomyOpen] = React.useState(false);
	const [bulkTagOpen, setBulkTagOpen] = React.useState(false);
	const [tagSearch, setTagSearch] = React.useState("");
	const tagSearchRef = React.useRef<HTMLInputElement>(null);
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
	const searchLocale = canonicalSearchLocale(activeLocale ?? i18n?.defaultLocale ?? "en");
	const rawSearch = tagSearch.trim();
	const tagMatches =
		taxonomyName === "tag" && rawSearch
			? findMatchingTagIds(
					terms,
					rawSearch.toLocaleLowerCase(searchLocale),
					rawSearch.toLowerCase(),
					searchLocale,
				)
			: null;

	const deleteMutation = useMutation({
		mutationFn: (term: TaxonomyTerm) =>
			deleteTerm(taxonomyName, term.slug, { locale: activeLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", taxonomyName] });
			setDeleteTarget(null);
			toastManager.add({ title: t`Term deleted` });
		},
	});

	const deleteTaxonomyMutation = useMutation({
		mutationFn: () => deleteTaxonomy(taxonomyName),
		onSuccess: () => {
			setDeleteTaxonomyOpen(false);
			onDeleted?.();
			// The sidebar entry comes from the manifest, not from the taxonomy list.
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-defs"] });
			// The page is still mounted while the route change settles, so refetching
			// these would ask for the taxonomy that was just deleted.
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-def", taxonomyName],
				refetchType: "none",
			});
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
				refetchType: "none",
			});
			toastManager.add({ title: t`Taxonomy deleted` });
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
			toastManager.add({ title: t`Error`, description: error.message, variant: "error" });
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
	const submitTranslate = useSingleFlight((input: { term: TaxonomyTerm; locale: string }) =>
		translateMutation.mutateAsync(input),
	);

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
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold leading-tight">{taxonomyDef.label}</h1>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Manage ${inlineLabel(taxonomyDef.label, lingui.locale)} for ${taxonomyDef.collections.join(", ")}`}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{i18n && activeLocale ? (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={setActiveLocale}
						/>
					) : null}
					{taxonomyName === "tag" ? (
						<>
							<Button
								variant="secondary"
								icon={<Tag aria-hidden="true" />}
								onClick={() => setFormOpen(true)}
							>
								{t`Add tag`}
							</Button>
							<Button
								variant="secondary"
								icon={<ADMIN_NAV_ICONS.posts weight="regular" aria-hidden="true" />}
								onClick={() => setBulkTagOpen(true)}
							>
								{t`Add to posts`}
							</Button>
						</>
					) : (
						<>
							<Button variant="outline" icon={<Plus />} onClick={() => setCreateTaxonomyOpen(true)}>
								{t`New Taxonomy`}
							</Button>
							<Button icon={<Plus />} onClick={() => setFormOpen(true)}>
								{t`Add ${taxonomyDef.labelSingular || t`Term`}`}
							</Button>
							<Button
								variant="outline"
								icon={<ADMIN_NAV_ICONS.posts weight="regular" aria-hidden="true" />}
								onClick={() => setBulkTagOpen(true)}
							>
								{t`Add to posts`}
							</Button>
						</>
					)}
					<DropdownMenu>
						<DropdownMenu.Trigger
							render={
								<Button
									type="button"
									variant={taxonomyName === "tag" ? "secondary" : "outline"}
									shape="square"
									icon={<DotsThree aria-hidden="true" />}
									aria-label={t`More actions for ${taxonomyDef.label}`}
								/>
							}
						/>
						<DropdownMenu.Content align="end">
							{taxonomyName === "tag" && (
								<>
									<DropdownMenu.Item
										icon={<StackSimple className="size-4" aria-hidden="true" />}
										onClick={() => setCreateTaxonomyOpen(true)}
									>
										{t`New taxonomy`}
									</DropdownMenu.Item>
									<DropdownMenu.Separator />
								</>
							)}
							<DropdownMenu.Item
								variant="danger"
								icon={<Trash className="size-4" aria-hidden="true" />}
								onClick={() => setDeleteTaxonomyOpen(true)}
							>
								{t`Delete taxonomy`}
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu>
				</div>
			</div>

			<div className="flex flex-col gap-3">
				{taxonomyName === "tag" && (
					<>
						<TableToolbarSearch
							size="base"
							inputRef={tagSearchRef}
							placeholder={t`Search tags…`}
							aria-label={t`Search tags`}
							value={tagSearch}
							onChange={(event) => setTagSearch(event.target.value)}
						/>
						<span role="status" className="sr-only">
							{rawSearch
								? plural(tagMatches?.matchCount ?? 0, {
										one: "# matching tag",
										other: "# matching tags",
									})
								: ""}
						</span>
					</>
				)}
				<DataTable>
					<thead>
						<tr>
							<th scope="col">{t`Name`}</th>
							<th scope="col" className="w-0 text-end">
								{t`Count`}
							</th>
							<th scope="col" className="w-0">
								<span className="sr-only">{t`Actions`}</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{termsLoading ? (
							<DataTableMessage colSpan={3}>{t`Loading terms...`}</DataTableMessage>
						) : terms.length === 0 ? (
							<DataTableMessage colSpan={3}>
								{t`No ${inlineLabel(taxonomyDef.label, lingui.locale)} yet. Create one to get started.`}
							</DataTableMessage>
						) : tagMatches?.visibleIds.size === 0 ? (
							<DataTableMessage colSpan={3}>
								<MagnifyingGlass size={32} className="mx-auto mb-2 opacity-60" aria-hidden="true" />
								<p className="font-medium text-kumo-default">{t`No matching tags`}</p>
								<Button
									variant="outline"
									size="sm"
									className="mx-auto mt-3"
									onClick={() => {
										setTagSearch("");
										tagSearchRef.current?.focus();
									}}
								>
									{t`Clear search`}
								</Button>
							</DataTableMessage>
						) : (
							<TermGroup
								siblings={terms}
								parentId={null}
								searchActive={!!tagMatches}
								visibleIds={tagMatches?.visibleIds}
								onEdit={handleEdit}
								onDelete={handleDelete}
								onMove={handleMove}
								onTranslate={setTranslateTarget}
								canTranslate={!!i18n && !!activeLocale && i18n.locales.length > 1}
							/>
						)}
					</tbody>
				</DataTable>
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
			<BulkTagDialog
				taxonomies={[taxonomyDef]}
				open={bulkTagOpen}
				activeLocale={activeLocale}
				defaultLocale={i18n?.defaultLocale}
				onClose={() => setBulkTagOpen(false)}
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
					onSubmit={(locale) => submitTranslate({ term: translateTarget, locale })}
				/>
			) : null}

			<ConfirmDialog
				open={!!deleteTarget}
				onClose={() => {
					setDeleteTarget(null);
					deleteMutation.reset();
				}}
				title={t`Delete ${taxonomyDef.labelSingular || t`Term`}?`}
				description={
					<>{t`This will permanently delete "${deleteTarget?.label}" and remove it from all content.`}</>
				}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
			/>

			<ConfirmDialog
				open={deleteTaxonomyOpen}
				role="alertdialog"
				onClose={() => {
					setDeleteTaxonomyOpen(false);
					deleteTaxonomyMutation.reset();
				}}
				title={t`Delete Taxonomy`}
				description={t`Deleting "${taxonomyDef.label}" also deletes every term in it, in all languages, and removes those terms from the content filed under them. The entries themselves are kept. This cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteTaxonomyMutation.isPending}
				error={deleteTaxonomyMutation.error}
				onConfirm={() => deleteTaxonomyMutation.mutate()}
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
