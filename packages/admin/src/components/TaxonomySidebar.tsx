/**
 * Taxonomy Sidebar for Content Editor
 *
 * Shows taxonomy selection UI in the content editor sidebar.
 * - Checkbox tree for hierarchical taxonomies (categories)
 * - Tag input for flat taxonomies (tags)
 */

import { Autocomplete, Badge, Button, Checkbox, Input, Label, Text, Toast } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse, throwResponseError } from "../lib/api/client.js";
import { createTerm, createTermTranslation, withLocale } from "../lib/api/taxonomies.js";
import { resolveTaxonomyDefinitions } from "../lib/taxonomy-definitions.js";
import { rankTermMatches, termExactMatches } from "../lib/taxonomy-match.js";
import { cn } from "../lib/utils.js";

interface TaxonomyTerm {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId?: string | null;
	children: TaxonomyTerm[];
	locale: string;
	translationGroup: string | null;
}

interface UnresolvedAssignment {
	translationGroup: string;
	availableLocales: string[];
	translations: Array<{ id: string; slug: string; locale: string }>;
}

interface EntryTermsResponse {
	terms: TaxonomyTerm[];
	unresolved: UnresolvedAssignment[];
	entryLocale: string;
	defaultLocale: string;
	implicitDefaultLocale: boolean;
}

interface TaxonomyDef {
	id: string;
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
	locale?: string;
	translationGroup?: string | null;
}

interface TaxonomySidebarProps {
	collection: string;
	entryId?: string;
	canManageTaxonomies: boolean;
	/** Locale of the entry being edited. Scopes term reads/writes so only the
	 * matching translation variants are shown — see issue #1218. */
	entryLocale?: string;
	/** Site default used when this logical taxonomy has no entry-locale definition. */
	defaultLocale?: string;
	onChange?: (taxonomyName: string, termIds: string[]) => void;
	/** Applied to the root when the section renders. Omitted when the section
	 * is empty so the caller doesn't need to guess whether to draw chrome. */
	className?: string;
}

const EMPTY_TERMS: TaxonomyTerm[] = [];
const EMPTY_UNRESOLVED_ASSIGNMENTS: UnresolvedAssignment[] = [];

type TagInputOption = { type: "term"; term: TaxonomyTerm } | { type: "create"; label: string };

/**
 * Fetch taxonomy definitions
 */
async function fetchTaxonomyDefs(): Promise<TaxonomyDef[]> {
	const res = await apiFetch(`/_emdash/api/taxonomies`);
	const data = await parseApiResponse<{ taxonomies: TaxonomyDef[] }>(
		res,
		"Failed to fetch taxonomies",
	);
	return data.taxonomies;
}

function useApplicableTaxonomies(
	collection: string,
	activeLocale?: string,
	defaultLocale?: string,
): TaxonomyDef[] {
	const { data: taxonomies = [] } = useQuery({
		queryKey: ["taxonomy-defs"],
		queryFn: fetchTaxonomyDefs,
	});
	return resolveTaxonomyDefinitions(taxonomies, activeLocale, defaultLocale).filter((taxonomy) =>
		taxonomy.collections.includes(collection),
	);
}

/** Whether the editor should include a taxonomy settings section. */
export function useHasApplicableTaxonomies(
	collection: string,
	activeLocale?: string,
	defaultLocale?: string,
): boolean {
	return useApplicableTaxonomies(collection, activeLocale, defaultLocale).length > 0;
}

/**
 * Fetch terms for a taxonomy, scoped to the entry's locale so only the matching
 * translation variants are offered. The picker shows no usage counts, so it
 * opts out of the per-collection count aggregate the endpoint runs by default.
 */
async function fetchTerms(taxonomyName: string, locale?: string): Promise<TaxonomyTerm[]> {
	const path = `/_emdash/api/taxonomies/${taxonomyName}/terms?includeCounts=false${locale ? "&resolveFallback=true" : ""}`;
	const res = await apiFetch(withLocale(path, locale));
	const data = await parseApiResponse<{ terms: TaxonomyTerm[] }>(
		res,
		i18n._(msg`Failed to fetch terms`),
	);
	return data.terms;
}

/**
 * Fetch entry terms
 */
async function fetchEntryTerms(
	collection: string,
	entryId: string,
	taxonomy: string,
): Promise<EntryTermsResponse> {
	const res = await apiFetch(`/_emdash/api/content/${collection}/${entryId}/terms/${taxonomy}`);
	const data = await parseApiResponse<EntryTermsResponse>(
		res,
		i18n._(msg`Failed to fetch entry terms`),
	);
	return data;
}

/**
 * Set entry terms
 */
async function setEntryTerms(
	collection: string,
	entryId: string,
	taxonomy: string,
	termIds: string[],
): Promise<void> {
	const res = await apiFetch(`/_emdash/api/content/${collection}/${entryId}/terms/${taxonomy}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ termIds }),
	});
	if (!res.ok) await throwResponseError(res, i18n._(msg`Failed to set entry terms`));
}

/**
 * Checkbox tree for hierarchical taxonomies
 */
function CategoryCheckboxTree({
	term,
	level = 0,
	selectedIds,
	onToggle,
	entryLocale,
}: {
	term: TaxonomyTerm;
	level?: number;
	selectedIds: Set<string>;
	onToggle: (termId: string) => void;
	entryLocale?: string;
}) {
	const isChecked = selectedIds.has(term.id);

	return (
		<div>
			<div
				className="py-1 hover:bg-kumo-tint/50 rounded px-2"
				style={{ marginInlineStart: `${level}rem` }}
			>
				<Checkbox
					checked={isChecked}
					onCheckedChange={() => onToggle(term.id)}
					label={
						<span className="inline-flex items-center gap-2 text-sm">
							{term.label}
							<TermLocaleBadge term={term} entryLocale={entryLocale} />
						</span>
					}
				/>
			</div>
			{term.children.map((child) => (
				<CategoryCheckboxTree
					key={child.id}
					term={child}
					level={level + 1}
					selectedIds={selectedIds}
					onToggle={onToggle}
					entryLocale={entryLocale}
				/>
			))}
		</div>
	);
}

/**
 * Tag input for flat taxonomies
 */
function TagInput({
	terms,
	selectedIds,
	onAdd,
	onRemove,
	onCreate,
	isCreating,
	createError,
	label,
	entryLocale,
	canCreate,
}: {
	terms: TaxonomyTerm[];
	selectedIds: Set<string>;
	onAdd: (termId: string) => void;
	onRemove: (termId: string) => void;
	onCreate: (label: string) => void;
	isCreating: boolean;
	createError?: Error | null;
	label: string;
	entryLocale?: string;
	canCreate: boolean;
}) {
	const { t } = useLingui();
	const [input, setInput] = React.useState("");
	const [isOpen, setIsOpen] = React.useState(false);

	const selectedTerms = terms.filter((term) => selectedIds.has(term.id));

	const trimmedInput = input.trim();

	const suggestions = React.useMemo(() => {
		const availableTerms = terms.filter((term) => !selectedIds.has(term.id));
		if (!trimmedInput) return availableTerms.slice(0, 5);
		return rankTermMatches(availableTerms, trimmedInput);
	}, [trimmedInput, terms, selectedIds]);

	const hasExactMatch = React.useMemo(() => {
		if (!trimmedInput) return false;
		return terms.some((term) => termExactMatches(term, trimmedInput));
	}, [trimmedInput, terms]);

	const showCreateOption = canCreate && trimmedInput.length > 0 && !hasExactMatch;
	const options = React.useMemo<TagInputOption[]>(
		() => [
			...suggestions.map((term) => ({ type: "term" as const, term })),
			...(showCreateOption ? [{ type: "create" as const, label: trimmedInput }] : []),
		],
		[suggestions, showCreateOption, trimmedInput],
	);

	const handleSelect = (term: TaxonomyTerm) => {
		onAdd(term.id);
		setInput("");
		setIsOpen(false);
	};

	const handleCreate = () => {
		if (!trimmedInput || isCreating) return;
		onCreate(trimmedInput);
		setInput("");
		setIsOpen(false);
	};

	return (
		<div className="space-y-2">
			{/* Selected tags */}
			{selectedTerms.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{selectedTerms.map((term) => (
						<span
							key={term.id}
							className="inline-flex items-center gap-1 px-2 py-1 text-sm bg-kumo-tint rounded-md"
						>
							{term.label}
							<TermLocaleBadge term={term} entryLocale={entryLocale} />
							<button
								type="button"
								onClick={() => onRemove(term.id)}
								className="hover:text-kumo-danger"
								aria-label={t`Remove ${term.label}`}
							>
								<X className="w-3 h-3" />
							</button>
						</span>
					))}
				</div>
			)}

			<div onFocus={() => setIsOpen(true)}>
				<Autocomplete
					items={options}
					value={input}
					onValueChange={setInput}
					open={isOpen && options.length > 0}
					onOpenChange={setIsOpen}
					mode="none"
					autoHighlight="always"
					openOnInputClick
					itemToStringValue={(option: TagInputOption) =>
						option.type === "term" ? option.term.label : option.label
					}
					label={<span className="sr-only">{t`Add ${label}`}</span>}
				>
					<Autocomplete.InputGroup placeholder={t`Add tags...`} className="text-sm" />
					<Autocomplete.Content>
						<Autocomplete.List style={{ maxHeight: "16rem", overflowY: "auto" }}>
							{(option: TagInputOption) => (
								<Autocomplete.Item
									key={option.type === "term" ? option.term.id : "create"}
									value={option}
									disabled={option.type === "create" && isCreating}
									onClick={() => {
										if (option.type === "term") handleSelect(option.term);
										else handleCreate();
									}}
								>
									{option.type === "term" ? (
										<span className="flex items-center gap-2">
											{option.term.label}
											<TermLocaleBadge term={option.term} entryLocale={entryLocale} />
										</span>
									) : (
										<span className="flex items-center gap-1 text-kumo-accent">
											<Plus className="h-3 w-3" aria-hidden="true" />
											{isCreating ? t`Creating...` : t`Create "${trimmedInput}"`}
										</span>
									)}
								</Autocomplete.Item>
							)}
						</Autocomplete.List>
					</Autocomplete.Content>
				</Autocomplete>
			</div>
			{createError ? <p className="text-sm text-kumo-danger">{createError.message}</p> : null}
		</div>
	);
}

function TermLocaleBadge({ term, entryLocale }: { term: TaxonomyTerm; entryLocale?: string }) {
	const { t } = useLingui();
	if (!entryLocale || term.locale === entryLocale) return null;
	return <Badge variant="secondary">{t`${term.locale.toUpperCase()} fallback`}</Badge>;
}

/**
 * Single taxonomy section
 */
function TaxonomySection({
	taxonomy,
	collection,
	entryId,
	entryLocale,
	canManageTaxonomies,
	onChange,
}: {
	taxonomy: TaxonomyDef;
	collection: string;
	entryId?: string;
	entryLocale?: string;
	canManageTaxonomies: boolean;
	onChange?: (termIds: string[]) => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [newCategoryLabel, setNewCategoryLabel] = React.useState("");
	const [showCategoryInput, setShowCategoryInput] = React.useState(false);

	// The count mode belongs in the key: the Taxonomies settings page reads the
	// same endpoint with counts and must not be served this count-free list.
	const { data: terms = EMPTY_TERMS } = useQuery({
		queryKey: ["taxonomy-terms", taxonomy.name, entryLocale, { includeCounts: false }],
		queryFn: () => fetchTerms(taxonomy.name, entryLocale),
	});

	const { data: entryTermsData } = useQuery({
		queryKey: ["entry-terms", collection, entryId, taxonomy.name, entryLocale],
		queryFn: () => {
			if (!entryId) return null;
			return fetchEntryTerms(collection, entryId, taxonomy.name);
		},
		enabled: !!entryId,
	});
	const entryTerms = entryTermsData?.terms ?? EMPTY_TERMS;
	const unresolved = entryTermsData?.unresolved ?? EMPTY_UNRESOLVED_ASSIGNMENTS;
	const resolvedEntryLocale = entryTermsData?.entryLocale ?? entryLocale;

	const saveMutation = useMutation({
		mutationFn: (termIds: string[]) => {
			if (!entryId) throw new Error("No entry ID");
			return setEntryTerms(collection, entryId, taxonomy.name, termIds);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["entry-terms", collection, entryId, taxonomy.name, entryLocale],
			});
			toastManager.add({ title: t`${taxonomy.label} updated` });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to update ${taxonomy.label.toLowerCase()}`,
				description: error instanceof Error ? error.message : t`An error occurred`,
				type: "error",
			});
		},
	});

	const createTermMutation = useMutation({
		mutationFn: (label: string) =>
			createTerm(taxonomy.name, {
				label,
				// Create the term in the entry's locale so it resolves on this entry.
				...(entryLocale ? { locale: entryLocale } : {}),
			}),
		onSuccess: (newTerm) => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomy.name, entryLocale],
			});
			// Auto-select the newly created term
			const newSelected = new Set(selectedIds);
			newSelected.add(newTerm.id);
			setSelectedIds(newSelected);

			const termIdsArray = [...newSelected];
			onChange?.(termIdsArray);

			if (entryId) {
				saveMutation.mutate(termIdsArray);
			}

			// Reset category input
			setNewCategoryLabel("");
			setShowCategoryInput(false);
		},
	});

	const createTranslationMutation = useMutation({
		mutationFn: async (assignment: UnresolvedAssignment) => {
			const source = assignment.translations[0];
			if (!source || !resolvedEntryLocale) {
				throw new Error(t`A source and target locale are required`);
			}
			return createTermTranslation(
				taxonomy.name,
				source.slug,
				{ locale: resolvedEntryLocale },
				{ locale: source.locale },
			);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomy.name, entryLocale],
			});
			void queryClient.invalidateQueries({
				queryKey: ["entry-terms", collection, entryId, taxonomy.name, entryLocale],
			});
			toastManager.add({ title: t`Translation created` });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to create translation`,
				description: error instanceof Error ? error.message : t`An error occurred`,
				type: "error",
			});
		},
	});

	const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

	// Sync selected IDs from entry terms
	React.useEffect(() => {
		const next = new Set(entryTerms.map((term) => term.id));
		for (const assignment of unresolved) {
			const source = assignment.translations[0];
			if (source) next.add(source.id);
		}
		setSelectedIds(next);
	}, [entryTerms, unresolved]);

	const activeUnresolved = unresolved.filter((assignment) => {
		const source = assignment.translations[0];
		return source ? selectedIds.has(source.id) : false;
	});

	const handleToggle = (termId: string) => {
		const newSelected = new Set(selectedIds);
		if (newSelected.has(termId)) {
			newSelected.delete(termId);
		} else {
			newSelected.add(termId);
		}
		setSelectedIds(newSelected);

		// Notify parent of change
		const termIdsArray = [...newSelected];
		onChange?.(termIdsArray);

		// Auto-save if entry exists
		if (entryId) {
			saveMutation.mutate(termIdsArray);
		}
	};

	const handleAdd = (termId: string) => {
		handleToggle(termId);
	};

	const handleRemove = (termId: string) => {
		handleToggle(termId);
	};

	const handleCreateCategory = () => {
		const label = newCategoryLabel.trim();
		if (!label || createTermMutation.isPending) return;
		createTermMutation.mutate(label);
	};

	return (
		<div className="space-y-2">
			<Label className="text-sm font-medium">{taxonomy.label}</Label>
			{activeUnresolved.map((assignment) => {
				const source = assignment.translations[0];
				if (!source) return null;
				return (
					<div
						key={assignment.translationGroup}
						className="space-y-2 rounded-lg border border-kumo-warning/50 bg-kumo-warning-tint p-3"
					>
						<p className="text-sm font-medium text-kumo-warning">{t`Unresolved assignment`}</p>
						<p className="text-xs text-kumo-subtle">
							{t`Available in ${assignment.availableLocales.map((locale) => locale.toUpperCase()).join(", ")}`}
						</p>
						<div className="flex flex-wrap gap-2">
							{canManageTaxonomies && resolvedEntryLocale ? (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => createTranslationMutation.mutate(assignment)}
									loading={createTranslationMutation.isPending}
								>
									{t`Create ${resolvedEntryLocale.toUpperCase()} translation`}
								</Button>
							) : null}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => handleToggle(source.id)}
							>
								{t`Remove assignment`}
							</Button>
						</div>
					</div>
				);
			})}

			{taxonomy.hierarchical ? (
				<>
					{terms.length === 0 ? (
						<p className="text-sm text-kumo-subtle">
							{t`No ${taxonomy.label.toLowerCase()} available.`}
						</p>
					) : (
						<div className="border rounded-lg p-2 max-h-64 overflow-y-auto">
							{terms.map((term) => (
								<CategoryCheckboxTree
									key={term.id}
									term={term}
									selectedIds={selectedIds}
									onToggle={handleToggle}
									entryLocale={resolvedEntryLocale}
								/>
							))}
						</div>
					)}

					{canManageTaxonomies &&
						(showCategoryInput ? (
							<div className="flex gap-1">
								<Input
									value={newCategoryLabel}
									onChange={(e) => setNewCategoryLabel(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleCreateCategory();
										} else if (e.key === "Escape") {
											setShowCategoryInput(false);
											setNewCategoryLabel("");
										}
									}}
									placeholder={t`New ${(taxonomy.labelSingular || taxonomy.label).toLowerCase()}`}
									className="text-sm flex-1"
									autoFocus
									disabled={createTermMutation.isPending}
								/>
								<Button
									type="button"
									onClick={handleCreateCategory}
									disabled={!newCategoryLabel.trim()}
									loading={createTermMutation.isPending}
									variant="primary"
								>
									{t`Add`}
								</Button>
							</div>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="-ms-2"
								onClick={() => setShowCategoryInput(true)}
								icon={<Plus />}
							>
								{t`Add new ${(taxonomy.labelSingular || taxonomy.label).toLowerCase()}`}
							</Button>
						))}
					{canManageTaxonomies && createTermMutation.error && (
						<p className="text-sm text-kumo-danger">
							{createTermMutation.error instanceof Error
								? createTermMutation.error.message
								: t`Failed to create term`}
						</p>
					)}
				</>
			) : (
				<TagInput
					terms={terms}
					selectedIds={selectedIds}
					onAdd={handleAdd}
					onRemove={handleRemove}
					onCreate={(label) => createTermMutation.mutate(label)}
					isCreating={createTermMutation.isPending}
					createError={canManageTaxonomies ? createTermMutation.error : null}
					label={taxonomy.label}
					entryLocale={resolvedEntryLocale}
					canCreate={canManageTaxonomies}
				/>
			)}
		</div>
	);
}

/**
 * Main TaxonomySidebar component
 */
export function TaxonomySidebar({
	collection,
	entryId,
	entryLocale,
	defaultLocale,
	canManageTaxonomies,
	onChange,
	className,
}: TaxonomySidebarProps) {
	const { t } = useLingui();
	const applicableTaxonomies = useApplicableTaxonomies(collection, entryLocale, defaultLocale);

	if (applicableTaxonomies.length === 0) {
		return null;
	}

	return (
		<div className={cn(className)}>
			<div>
				<Text bold as="h3" DANGEROUS_className="mb-4">
					{t`Taxonomies`}
				</Text>
				<div className="space-y-4">
					{applicableTaxonomies.map((taxonomy) => (
						<TaxonomySection
							key={taxonomy.name}
							taxonomy={taxonomy}
							collection={collection}
							entryId={entryId}
							entryLocale={entryLocale}
							canManageTaxonomies={canManageTaxonomies}
							onChange={(termIds) => onChange?.(taxonomy.name, termIds)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
