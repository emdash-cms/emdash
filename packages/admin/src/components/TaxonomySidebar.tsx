/**
 * Taxonomy Sidebar for Content Editor
 *
 * Shows taxonomy selection UI in the content editor sidebar.
 * - Checkbox tree for hierarchical taxonomies (categories)
 * - Tag input for flat taxonomies (tags)
 */

import { Input, Label } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse, throwResponseError } from "../lib/api/client.js";

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
	const data = await parseApiResponse<{ terms: TaxonomyTerm[] }>(res, "Failed to fetch terms");
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
		"Failed to fetch entry terms",
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
	if (!res.ok) await throwResponseError(res, "Failed to set entry terms");
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
			<label
				className="flex items-center py-1 cursor-pointer hover:bg-kumo-tint/50 rounded px-2"
				style={{ marginLeft: `${level}rem` }}
			>
				<input
					type="checkbox"
					checked={isChecked}
					onChange={() => onToggle(term.id)}
					className="mr-2"
				/>
				<span className="text-sm">{term.label}</span>
			</label>
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
	label,
}: {
	terms: TaxonomyTerm[];
	selectedIds: Set<string>;
	onAdd: (termId: string) => void;
	onRemove: (termId: string) => void;
	label: string;
}) {
	const [input, setInput] = React.useState("");

	const selectedTerms = terms.filter((t) => selectedIds.has(t.id));

	const suggestions = React.useMemo(() => {
		if (!input) return [];
		return terms
			.filter((t) => t.label.toLowerCase().includes(input.toLowerCase()) && !selectedIds.has(t.id))
			.slice(0, 5);
	}, [input, terms, selectedIds]);

	const handleSelect = (term: TaxonomyTerm) => {
		onAdd(term.id);
		setInput("");
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
								aria-label={`Remove ${term.label}`}
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
					placeholder="Add tags..."
					aria-label={`Add ${label}`}
					className="text-sm"
				/>

				{/* Suggestions dropdown */}
				{suggestions.length > 0 && (
					<div className="absolute top-full left-0 right-0 mt-1 bg-kumo-overlay border rounded-md shadow-lg z-10">
						{suggestions.map((term) => (
							<button
								key={term.id}
								type="button"
								onClick={() => handleSelect(term)}
								className="w-full text-left px-3 py-2 text-sm hover:bg-kumo-tint"
							>
								{term.label}
							</button>
						))}
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
	const queryClient = useQueryClient();

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
		},
	});

	const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

	// Sync selected IDs from entry terms
	React.useEffect(() => {
		setSelectedIds(new Set(entryTerms.map((t) => t.id)));
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

	return (
		<div className="space-y-2">
			<Label className="text-sm font-medium">{taxonomy.label}</Label>

			{terms.length === 0 ? (
				<p className="text-sm text-kumo-subtle">No {taxonomy.label.toLowerCase()} available.</p>
			) : taxonomy.hierarchical ? (
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
			) : (
				<TagInput
					terms={terms}
					selectedIds={selectedIds}
					onAdd={handleAdd}
					onRemove={handleRemove}
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
	const { data: taxonomies = [] } = useQuery({
		queryKey: ["taxonomy-defs"],
		queryFn: fetchTaxonomyDefs,
	});

	// Filter to taxonomies that apply to this collection
	const applicableTaxonomies = taxonomies.filter((t) => t.collections.includes(collection));

	if (applicableTaxonomies.length === 0) {
		return null;
	}

	return (
		<div className="space-y-6">
			<div>
				<h3 className="font-semibold mb-4">Taxonomies</h3>
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
