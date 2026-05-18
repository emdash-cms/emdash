/**
 * Taxonomy Sidebar for Content Editor
 *
 * Shows taxonomy selection UI in the content editor sidebar.
 * - Checkbox tree for hierarchical taxonomies (categories)
 * - Tag input for flat taxonomies (tags)
 */

import { Button, Checkbox, Input, Label, Toast } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse, throwResponseError } from "../lib/api/client.js";
import { createTerm } from "../lib/api/taxonomies.js";
import { termExactMatches, termMatches } from "../lib/taxonomy-match.js";
import { slugify } from "../lib/utils.js";

interface TaxonomyTerm {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId?: string;
	children: TaxonomyTerm[];
}

interface TaxonomyDef {
	id: string;
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
}

interface TaxonomySidebarProps {
	collection: string;
	entryId?: string;
	onChange?: (taxonomyName: string, termIds: string[]) => void;
}

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

/**
 * Fetch terms for a taxonomy
 */
async function fetchTerms(taxonomyName: string): Promise<TaxonomyTerm[]> {
	const res = await apiFetch(`/_emdash/api/taxonomies/${taxonomyName}/terms`);
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
): Promise<TaxonomyTerm[]> {
	const res = await apiFetch(`/_emdash/api/content/${collection}/${entryId}/terms/${taxonomy}`);
	const data = await parseApiResponse<{ terms: TaxonomyTerm[] }>(
		res,
		i18n._(msg`Failed to fetch entry terms`),
	);
	return data.terms;
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
}: {
	term: TaxonomyTerm;
	level?: number;
	selectedIds: Set<string>;
	onToggle: (termId: string) => void;
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
					label={<span className="text-sm">{term.label}</span>}
				/>
			</div>
			{term.children.map((child) => (
				<CategoryCheckboxTree
					key={child.id}
					term={child}
					level={level + 1}
					selectedIds={selectedIds}
					onToggle={onToggle}
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
	label,
}: {
	terms: TaxonomyTerm[];
	selectedIds: Set<string>;
	onAdd: (termId: string) => void;
	onRemove: (termId: string) => void;
	onCreate: (label: string) => void;
	isCreating: boolean;
	label: string;
}) {
	const { t } = useLingui();
	const [input, setInput] = React.useState("");

	const selectedTerms = terms.filter((term) => selectedIds.has(term.id));

	const trimmedInput = input.trim();

	const suggestions = React.useMemo(() => {
		if (!trimmedInput) return [];
		return terms
			.filter((term) => !selectedIds.has(term.id) && termMatches(term, trimmedInput))
			.slice(0, 5);
	}, [trimmedInput, terms, selectedIds]);

	const hasExactMatch = React.useMemo(() => {
		if (!trimmedInput) return false;
		return terms.some((term) => termExactMatches(term, trimmedInput));
	}, [trimmedInput, terms]);

	const showCreateOption = trimmedInput.length > 0 && !hasExactMatch;

	const handleSelect = (term: TaxonomyTerm) => {
		onAdd(term.id);
		setInput("");
	};

	const handleCreate = () => {
		if (!trimmedInput || isCreating) return;
		onCreate(trimmedInput);
		setInput("");
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (suggestions.length === 1 && !showCreateOption) {
				handleSelect(suggestions[0]!);
			} else if (showCreateOption && suggestions.length === 0) {
				handleCreate();
			}
		}
	};

	return (
		<div className="space-y-2">
			{/* Selected tags */}
			{selectedTerms.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{selectedTerms.map((term) => (
						<span
							key={term.id}
							className="inline-flex items-center gap-1 px-2 py-1 text-sm bg-kumo-tint rounded"
						>
							{term.label}
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

			{/* Input with autocomplete */}
			<div className="relative">
				<Input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t`Add tags...`}
					aria-label={t`Add ${label}`}
					className="text-sm"
				/>

				{/* Suggestions dropdown */}
				{(suggestions.length > 0 || showCreateOption) && (
					<div className="absolute top-full start-0 end-0 mt-1 bg-kumo-overlay border rounded-md shadow-lg z-10">
						{suggestions.map((term) => (
							<button
								key={term.id}
								type="button"
								onClick={() => handleSelect(term)}
								className="w-full text-start px-3 py-2 text-sm hover:bg-kumo-tint"
							>
								{term.label}
							</button>
						))}
						{showCreateOption && (
							<button
								type="button"
								onClick={handleCreate}
								disabled={isCreating}
								className="w-full text-start px-3 py-2 text-sm hover:bg-kumo-tint text-kumo-accent flex items-center gap-1 border-t"
							>
								<Plus className="w-3 h-3" />
								{isCreating ? t`Creating...` : t`Create "${trimmedInput}"`}
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Single taxonomy section
 */
function TaxonomySection({
	taxonomy,
	collection,
	entryId,
	onChange,
}: {
	taxonomy: TaxonomyDef;
	collection: string;
	entryId?: string;
	onChange?: (termIds: string[]) => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [newCategoryLabel, setNewCategoryLabel] = React.useState("");
	const [showCategoryInput, setShowCategoryInput] = React.useState(false);

	const { data: terms = [] } = useQuery({
		queryKey: ["taxonomy-terms", taxonomy.name],
		queryFn: () => fetchTerms(taxonomy.name),
	});

	const { data: entryTerms = [] } = useQuery({
		queryKey: ["entry-terms", collection, entryId, taxonomy.name],
		queryFn: () => {
			if (!entryId) return [];
			return fetchEntryTerms(collection, entryId, taxonomy.name);
		},
		enabled: !!entryId,
	});

	const saveMutation = useMutation({
		mutationFn: (termIds: string[]) => {
			if (!entryId) throw new Error("No entry ID");
			return setEntryTerms(collection, entryId, taxonomy.name, termIds);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["entry-terms", collection, entryId, taxonomy.name],
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
		mutationFn: (label: string) => createTerm(taxonomy.name, { slug: slugify(label), label }),
		onSuccess: (newTerm) => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", taxonomy.name] });
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

	const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

	// Sync selected IDs from entry terms
	React.useEffect(() => {
		setSelectedIds(new Set(entryTerms.map((term) => term.id)));
	}, [entryTerms]);

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

			{taxonomy.hierarchical ? (
				<>
					{terms.length === 0 ? (
						<p className="text-sm text-kumo-subtle">
							{t`No ${taxonomy.label.toLowerCase()} available.`}
						</p>
					) : (
						<div className="border rounded-md p-2 max-h-64 overflow-y-auto">
							{terms.map((term) => (
								<CategoryCheckboxTree
									key={term.id}
									term={term}
									selectedIds={selectedIds}
									onToggle={handleToggle}
								/>
							))}
						</div>
					)}

					{/* Add new category inline */}
					{showCategoryInput ? (
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
						<button
							type="button"
							onClick={() => setShowCategoryInput(true)}
							className="text-sm text-kumo-accent hover:underline flex items-center gap-1"
						>
							<Plus className="w-3 h-3" />
							{t`Add new ${(taxonomy.labelSingular || taxonomy.label).toLowerCase()}`}
						</button>
					)}
					{createTermMutation.error && (
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
					label={taxonomy.label}
				/>
			)}
		</div>
	);
}

/**
 * Main TaxonomySidebar component
 */
export function TaxonomySidebar({ collection, entryId, onChange }: TaxonomySidebarProps) {
	const { t } = useLingui();
	const { data: taxonomies = [] } = useQuery({
		queryKey: ["taxonomy-defs"],
		queryFn: fetchTaxonomyDefs,
	});

	// Filter to taxonomies that apply to this collection
	const applicableTaxonomies = taxonomies.filter((tax) => tax.collections.includes(collection));

	if (applicableTaxonomies.length === 0) {
		return null;
	}

	return (
		<div className="space-y-6">
			<div>
				<h3 className="font-semibold mb-4">{t`Taxonomies`}</h3>
				<div className="space-y-4">
					{applicableTaxonomies.map((taxonomy) => (
						<TaxonomySection
							key={taxonomy.name}
							taxonomy={taxonomy}
							collection={collection}
							entryId={entryId}
							onChange={(termIds) => onChange?.(taxonomy.name, termIds)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
