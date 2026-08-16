/**
 * Taxonomy Sidebar for Content Editor
 *
 * Shows taxonomy selection UI in the content editor sidebar.
 * - Checkbox tree for hierarchical taxonomies (categories)
 * - Tag input for flat taxonomies (tags)
 */

import { Button, Checkbox, Combobox, Input, Label, Text, Toast } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse, throwResponseError } from "../lib/api/client.js";
import { createTerm, withLocale } from "../lib/api/taxonomies.js";
import { termExactMatches, termMatches } from "../lib/taxonomy-match.js";
import { cn, slugify } from "../lib/utils.js";

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

type TagPickerOption = { kind: "term"; term: TaxonomyTerm } | { kind: "create"; label: string };

interface TaxonomySidebarProps {
	collection: string;
	entryId?: string;
	/** Locale of the entry being edited. Scopes term reads/writes so only the
	 * matching translation variants are shown — see issue #1218. */
	entryLocale?: string;
	onChange?: (taxonomyName: string, termIds: string[]) => void;
	/** Applied to the root when the section renders. Omitted when the section
	 * is empty so the caller doesn't need to guess whether to draw chrome. */
	className?: string;
}

const EMPTY_TERMS: TaxonomyTerm[] = [];

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

function useApplicableTaxonomies(collection: string): TaxonomyDef[] {
	const { data: taxonomies = [] } = useQuery({
		queryKey: ["taxonomy-defs"],
		queryFn: fetchTaxonomyDefs,
	});
	return taxonomies.filter((taxonomy) => taxonomy.collections.includes(collection));
}

/** Whether the editor should include a taxonomy settings section. */
export function useHasApplicableTaxonomies(collection: string): boolean {
	return useApplicableTaxonomies(collection).length > 0;
}

/**
 * Fetch terms for a taxonomy, scoped to the entry's locale so only the matching
 * translation variants are offered. The picker shows no usage counts, so it
 * opts out of the per-collection count aggregate the endpoint runs by default.
 */
async function fetchTerms(taxonomyName: string, locale?: string): Promise<TaxonomyTerm[]> {
	const res = await apiFetch(
		withLocale(`/_emdash/api/taxonomies/${taxonomyName}/terms?includeCounts=false`, locale),
	);
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
	locale?: string,
): Promise<TaxonomyTerm[]> {
	const res = await apiFetch(
		withLocale(`/_emdash/api/content/${collection}/${entryId}/terms/${taxonomy}`, locale),
	);
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
	locale?: string,
): Promise<void> {
	const res = await apiFetch(
		withLocale(`/_emdash/api/content/${collection}/${entryId}/terms/${taxonomy}`, locale),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ termIds }),
		},
	);
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
	onChange,
	onCreate,
	onCreateErrorClear,
	isCreating,
	createError,
	label,
}: {
	terms: TaxonomyTerm[];
	selectedIds: Set<string>;
	onChange: (termIds: string[]) => void;
	onCreate: (label: string) => Promise<void>;
	onCreateErrorClear: () => void;
	isCreating: boolean;
	createError: unknown;
	label: string;
}) {
	const { t } = useLingui();
	const [input, setInput] = React.useState("");
	const [isOpen, setIsOpen] = React.useState(false);
	const trimmedInput = input.trim();

	const hasExactMatch = React.useMemo(() => {
		if (!trimmedInput) return false;
		return terms.some((term) => termExactMatches(term, trimmedInput));
	}, [trimmedInput, terms]);

	const showCreateOption = trimmedInput.length > 0 && !hasExactMatch;
	const termOptions = React.useMemo<TagPickerOption[]>(
		() => terms.map((term) => ({ kind: "term", term })),
		[terms],
	);
	const selectedOptions = React.useMemo(
		() => termOptions.filter((option) => option.kind === "term" && selectedIds.has(option.term.id)),
		[termOptions, selectedIds],
	);
	const visibleOptions = React.useMemo(() => {
		const matches = trimmedInput
			? termOptions.filter(
					(option) => option.kind === "term" && termMatches(option.term, trimmedInput),
				)
			: termOptions;
		const ordered = trimmedInput
			? matches.toSorted((a, b) => {
					if (a.kind !== "term" || b.kind !== "term") return 0;
					return (
						Number(termExactMatches(b.term, trimmedInput)) -
						Number(termExactMatches(a.term, trimmedInput))
					);
				})
			: matches;

		if (!showCreateOption) return ordered;
		return [...ordered, { kind: "create", label: trimmedInput } satisfies TagPickerOption];
	}, [showCreateOption, termOptions, trimmedInput]);

	const handleValueChange = (options: TagPickerOption[]) => {
		const createOption = options.find((option) => option.kind === "create");
		if (createOption?.kind === "create") {
			if (isCreating) return;
			void onCreate(createOption.label)
				.then(() => setInput(""))
				.catch(() => {
					setInput(createOption.label);
					setIsOpen(true);
				});
			return;
		}

		if (createError) onCreateErrorClear();
		onChange(options.flatMap((option) => (option.kind === "term" ? [option.term.id] : [])));
		setInput("");
	};

	return (
		<Combobox
			multiple
			label={label}
			error={
				createError
					? createError instanceof Error
						? createError.message
						: t`Failed to create term`
					: undefined
			}
			open={isOpen}
			onOpenChange={(open, eventDetails) => {
				if (!open && eventDetails.reason === "item-press") return;
				setIsOpen(open);
			}}
			items={visibleOptions}
			value={selectedOptions}
			inputValue={input}
			onInputValueChange={(value) => {
				if (createError) onCreateErrorClear();
				setInput(value);
			}}
			onValueChange={handleValueChange}
			isItemEqualToValue={(option, value) =>
				option.kind === "term" && value.kind === "term" && option.term.id === value.term.id
			}
			itemToStringLabel={(option) => (option.kind === "term" ? option.term.label : option.label)}
			itemToStringValue={(option) => (option.kind === "term" ? option.term.id : option.label)}
			filter={null}
			autoHighlight
		>
			<Combobox.TriggerMultipleWithInput
				value={selectedOptions}
				placeholder={t`Add tags...`}
				renderItem={(option) =>
					option.kind === "term" ? (
						<Combobox.Chip removeLabel={t`Remove ${option.term.label}`}>
							{option.term.label}
						</Combobox.Chip>
					) : null
				}
			/>
			<Combobox.Content>
				<Combobox.Empty>{t`No results`}</Combobox.Empty>
				<Combobox.List style={{ maxHeight: "11rem" }}>
					{(option: TagPickerOption) => (
						<Combobox.Item
							key={option.kind === "term" ? option.term.id : `create:${option.label}`}
							value={option}
							disabled={option.kind === "create" && isCreating}
						>
							{option.kind === "term" ? (
								option.term.label
							) : (
								<span className="flex items-center gap-1 text-kumo-accent">
									<Plus className="h-3 w-3" aria-hidden="true" />
									{isCreating ? t`Creating...` : t`Create "${option.label}"`}
								</span>
							)}
						</Combobox.Item>
					)}
				</Combobox.List>
			</Combobox.Content>
		</Combobox>
	);
}

/**
 * Single taxonomy section
 */
function TaxonomySection({
	taxonomy,
	collection,
	entryId,
	entryLocale,
	onChange,
}: {
	taxonomy: TaxonomyDef;
	collection: string;
	entryId?: string;
	entryLocale?: string;
	onChange?: (termIds: string[]) => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [newCategoryLabel, setNewCategoryLabel] = React.useState("");
	const [showCategoryInput, setShowCategoryInput] = React.useState(false);
	const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
	const selectedIdsRef = React.useRef(selectedIds);

	// The count mode belongs in the key: the Taxonomies settings page reads the
	// same endpoint with counts and must not be served this count-free list.
	const termsQueryKey = [
		"taxonomy-terms",
		taxonomy.name,
		entryLocale,
		{ includeCounts: false },
	] as const;
	const { data: terms = EMPTY_TERMS } = useQuery({
		queryKey: termsQueryKey,
		queryFn: () => fetchTerms(taxonomy.name, entryLocale),
	});

	const { data: entryTerms = EMPTY_TERMS } = useQuery({
		queryKey: ["entry-terms", collection, entryId, taxonomy.name, entryLocale],
		queryFn: () => {
			if (!entryId) return [];
			return fetchEntryTerms(collection, entryId, taxonomy.name, entryLocale);
		},
		enabled: !!entryId,
	});

	const saveMutationKey = ["entry-terms-save", collection, entryId, taxonomy.name, entryLocale];
	const saveMutation = useMutation({
		mutationKey: saveMutationKey,
		scope: {
			id: `entry-terms:${collection}:${entryId ?? "new"}:${taxonomy.name}:${entryLocale ?? ""}`,
		},
		mutationFn: (termIds: string[]) => {
			if (!entryId) throw new Error("No entry ID");
			return setEntryTerms(collection, entryId, taxonomy.name, termIds, entryLocale);
		},
		onSuccess: () => {
			if (queryClient.isMutating({ mutationKey: saveMutationKey }) > 1) return;
			toastManager.add({ title: t`${taxonomy.label} updated` });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to update ${taxonomy.label.toLowerCase()}`,
				description: error instanceof Error ? error.message : t`An error occurred`,
				type: "error",
			});
		},
		onSettled: () => {
			if (queryClient.isMutating({ mutationKey: saveMutationKey }) > 1) return;
			void queryClient.invalidateQueries({
				queryKey: ["entry-terms", collection, entryId, taxonomy.name, entryLocale],
			});
		},
	});

	const createTermMutation = useMutation({
		mutationFn: (label: string) =>
			createTerm(taxonomy.name, {
				slug: slugify(label),
				label,
				// Create the term in the entry's locale so it resolves on this entry.
				...(entryLocale ? { locale: entryLocale } : {}),
			}),
		onSuccess: (newTerm) => {
			queryClient.setQueryData<TaxonomyTerm[]>(termsQueryKey, (current = []) =>
				current.some((term) => term.id === newTerm.id) ? current : [...current, newTerm],
			);
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomy.name, entryLocale],
			});
			const newSelected = new Set(selectedIdsRef.current);
			newSelected.add(newTerm.id);
			selectedIdsRef.current = newSelected;
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

	React.useEffect(() => {
		const nextSelected = new Set(entryTerms.map((term) => term.id));
		selectedIdsRef.current = nextSelected;
		setSelectedIds(nextSelected);
	}, [entryTerms]);

	const handleToggle = (termId: string) => {
		const newSelected = new Set(selectedIds);
		if (newSelected.has(termId)) {
			newSelected.delete(termId);
		} else {
			newSelected.add(termId);
		}
		handleSelectionChange([...newSelected]);
	};

	const handleSelectionChange = (termIdsArray: string[]) => {
		const nextSelected = new Set(termIdsArray);
		selectedIdsRef.current = nextSelected;
		setSelectedIds(nextSelected);
		onChange?.(termIdsArray);

		if (entryId) {
			saveMutation.mutate(termIdsArray);
		}
	};

	const handleCreateCategory = () => {
		const label = newCategoryLabel.trim();
		if (!label || createTermMutation.isPending) return;
		createTermMutation.mutate(label);
	};

	return (
		<div className="space-y-2">
			{taxonomy.hierarchical ? (
				<>
					<Label className="text-sm font-medium">{taxonomy.label}</Label>
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
					onChange={handleSelectionChange}
					onCreate={async (label) => {
						await createTermMutation.mutateAsync(label);
					}}
					onCreateErrorClear={createTermMutation.reset}
					isCreating={createTermMutation.isPending}
					createError={createTermMutation.error}
					label={taxonomy.label}
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
	onChange,
	className,
}: TaxonomySidebarProps) {
	const { t } = useLingui();
	const applicableTaxonomies = useApplicableTaxonomies(collection);

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
							onChange={(termIds) => onChange?.(taxonomy.name, termIds)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
