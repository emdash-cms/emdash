/**
 * Taxonomy Sidebar for Content Editor
 *
 * Shows taxonomy selection UI in the content editor sidebar.
 * - Shared multi-select picker for hierarchical and flat taxonomies
 */

import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { InputGroup } from "@cloudflare/kumo/components/input-group";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { Toast } from "@cloudflare/kumo/components/toast";
import { Popover as PopoverPrimitive } from "@cloudflare/kumo/primitives/popover";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, parseApiResponse, throwResponseError } from "../lib/api/client.js";
import { createTerm, createTermTranslation, withLocale } from "../lib/api/taxonomies.js";
import { resolveTaxonomyDefinitions } from "../lib/taxonomy-definitions.js";
import { foldForMatch, termExactMatches, termMatches } from "../lib/taxonomy-match.js";
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
const TERM_VALUE_SEPARATOR = /[,\r\n]+/;
const TERM_VALUE_DISPLAY_SEPARATOR = /[,\r\n]+/g;
const PASTED_LINE_BREAK = /[\r\n]/;
const MAX_VISIBLE_TERM_OPTIONS = 100;

interface FlatTaxonomyTerm {
	term: TaxonomyTerm;
	depth: number;
}

type TaxonomyPickerOption = { kind: "term" } & FlatTaxonomyTerm;

function flattenTerms(terms: TaxonomyTerm[], depth = 0): FlatTaxonomyTerm[] {
	return terms.flatMap((term) => [{ term, depth }, ...flattenTerms(term.children, depth + 1)]);
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

function TaxonomyTermPicker({
	terms,
	selectedIds,
	onChange,
	onCreate,
	isCreating,
	createError,
	label,
	entryLocale,
	canCreate,
	allowDelimitedValues,
	singularLabel,
}: {
	terms: TaxonomyTerm[];
	selectedIds: Set<string>;
	onChange: (termIds: string[]) => void;
	onCreate: (labels: string[], matchedIds: string[]) => void;
	isCreating: boolean;
	createError?: Error | null;
	label: string;
	entryLocale?: string;
	canCreate: boolean;
	allowDelimitedValues: boolean;
	singularLabel: string;
}) {
	const { t } = useLingui();
	const [input, setInput] = React.useState("");
	const [isOpen, setIsOpen] = React.useState(false);
	const [activeIndex, setActiveIndex] = React.useState(0);
	const anchorRef = React.useRef<HTMLDivElement>(null);
	const fieldTriggerRef = React.useRef<HTMLButtonElement>(null);
	const addTriggerRef = React.useRef<HTMLButtonElement>(null);
	const lastTriggerRef = React.useRef<HTMLButtonElement | null>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
	const pastedDelimitedInputRef = React.useRef<string | null>(null);
	const listId = React.useId();
	const triggerId = React.useId();
	const inputId = React.useId();
	const trimmedInput = input.trim();
	const flatTerms = React.useMemo(() => flattenTerms(terms), [terms]);
	const termOptions = React.useMemo<TaxonomyPickerOption[]>(
		() => flatTerms.map(({ term, depth }) => ({ kind: "term", term, depth })),
		[flatTerms],
	);
	const selectedOptions = React.useMemo(
		() =>
			termOptions.filter(
				(option): option is Extract<TaxonomyPickerOption, { kind: "term" }> =>
					option.kind === "term" && selectedIds.has(option.term.id),
			),
		[termOptions, selectedIds],
	);
	const visibleOptions = React.useMemo(() => {
		const matches = trimmedInput
			? termOptions.filter((option) => termMatches(option.term, trimmedInput))
			: termOptions;
		const ordered = trimmedInput
			? matches.toSorted((a, b) => {
					return (
						Number(termExactMatches(b.term, trimmedInput)) -
						Number(termExactMatches(a.term, trimmedInput))
					);
				})
			: matches;
		return ordered.slice(0, MAX_VISIBLE_TERM_OPTIONS);
	}, [termOptions, trimmedInput]);
	const hasExactMatch = flatTerms.some(({ term }) => termExactMatches(term, trimmedInput));
	const canCreateInput = canCreate && Boolean(trimmedInput) && !hasExactMatch;
	const selectedTermIds = selectedOptions.map((option) => option.term.id);

	React.useEffect(() => {
		setActiveIndex((current) => Math.min(current, Math.max(visibleOptions.length - 1, 0)));
	}, [visibleOptions.length]);

	React.useEffect(() => {
		if (!isOpen) return;
		const frame = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [isOpen]);

	const closePicker = () => {
		setIsOpen(false);
		setInput("");
		setActiveIndex(0);
		pastedDelimitedInputRef.current = null;
	};
	const openPicker = (trigger: HTMLButtonElement | null) => {
		lastTriggerRef.current = trigger;
		setIsOpen(true);
	};

	const toggleTerm = (termId: string) => {
		const nextSelected = new Set(selectedTermIds);
		if (nextSelected.has(termId)) nextSelected.delete(termId);
		else nextSelected.add(termId);
		onChange([...nextSelected]);
	};

	const handleCreate = () => {
		if (!trimmedInput) {
			inputRef.current?.focus();
			return;
		}
		if (isCreating) return;

		const creationInput = pastedDelimitedInputRef.current ?? trimmedInput;
		const seenValues = new Set<string>();
		const inputValues = (
			allowDelimitedValues ? creationInput.split(TERM_VALUE_SEPARATOR) : [creationInput]
		)
			.map((value) => value.trim())
			.filter((value) => {
				const identity = foldForMatch(value).trim();
				if (!identity || seenValues.has(identity)) return false;
				seenValues.add(identity);
				return true;
			});
		const matchedIds: string[] = [];
		const newLabels: string[] = [];

		for (const value of inputValues) {
			const matchingTerm = flatTerms.find(({ term }) => termExactMatches(term, value));
			if (matchingTerm) {
				if (!selectedIds.has(matchingTerm.term.id)) matchedIds.push(matchingTerm.term.id);
			} else if (canCreate) {
				newLabels.push(value);
			}
		}

		if (newLabels.length > 0) onCreate(newLabels, matchedIds);
		else if (matchedIds.length > 0) {
			onChange([...new Set([...selectedTermIds, ...matchedIds])]);
		}
		setInput("");
		setActiveIndex(0);
		pastedDelimitedInputRef.current = null;
	};

	const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setIsOpen(true);
			if (visibleOptions.length === 0) return;
			const nextIndex = event.key === "ArrowDown" ? 0 : visibleOptions.length - 1;
			setActiveIndex(nextIndex);
			requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const activeOption = visibleOptions[activeIndex];
			if (activeOption) toggleTerm(activeOption.term.id);
			else if (canCreateInput) handleCreate();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closePicker();
			requestAnimationFrame(() => lastTriggerRef.current?.focus());
			return;
		}
		if (event.key === "Backspace" && !input && selectedOptions.length > 0) {
			event.preventDefault();
			const lastSelected = selectedOptions.at(-1);
			if (lastSelected) toggleTerm(lastSelected.term.id);
		}
	};

	const handleOptionKeyDown = (
		event: React.KeyboardEvent<HTMLElement>,
		index: number,
		termId: string,
	) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const nextIndex =
				event.key === "ArrowDown"
					? (index + 1) % visibleOptions.length
					: (index - 1 + visibleOptions.length) % visibleOptions.length;
			setActiveIndex(nextIndex);
			optionRefs.current[nextIndex]?.focus();
		} else if (event.key === "Enter") {
			event.preventDefault();
			toggleTerm(termId);
		} else if (event.key === "Escape") {
			event.preventDefault();
			closePicker();
			requestAnimationFrame(() => lastTriggerRef.current?.focus());
		}
	};

	return (
		<PopoverPrimitive.Root
			open={isOpen}
			triggerId={triggerId}
			onOpenChange={(open) => {
				if (open) setIsOpen(true);
				else closePicker();
			}}
		>
			<div ref={anchorRef} className="grid min-w-0 gap-1.5">
				<div className="flex min-w-0 items-center justify-between gap-2">
					<Text bold as="span">
						{label}
					</Text>
					<Button
						ref={addTriggerRef}
						type="button"
						variant="ghost"
						size="xs"
						shape="square"
						className="ms-auto me-1.5 h-6 w-6 min-w-6 shrink-0 text-kumo-subtle hover:text-kumo-default"
						title={t`Choose ${label}`}
						aria-label={t`Choose ${label}`}
						aria-expanded={isOpen}
						aria-controls={listId}
						disabled={isCreating}
						loading={isCreating}
						onClick={() => {
							if (isOpen) closePicker();
							else openPicker(addTriggerRef.current);
						}}
						icon={<Plus size={14} aria-hidden="true" />}
					/>
				</div>
				<LayerCard className="relative flex min-h-9 items-start bg-kumo-control p-1.5 shadow-none">
					<Button
						ref={fieldTriggerRef}
						id={triggerId}
						type="button"
						variant="ghost"
						className="absolute inset-0 z-0 h-full w-full min-w-0 rounded-lg bg-transparent p-0 hover:bg-transparent"
						aria-label={t`Edit ${label}`}
						aria-expanded={isOpen}
						aria-controls={listId}
						disabled={isCreating}
						onClick={() => {
							if (isOpen) closePicker();
							else openPicker(fieldTriggerRef.current);
						}}
					>
						<span className="sr-only">{t`Edit ${label}`}</span>
					</Button>
					{selectedOptions.length > 0 ? (
						<div
							role="list"
							aria-label={t`Selected ${label}`}
							style={{
								boxSizing: "border-box",
								maxHeight: "calc(5.25rem + 2px)",
								padding: "1px",
								scrollbarGutter: "stable",
								scrollbarWidth: "thin",
							}}
							className="relative z-1 flex w-full min-w-0 flex-wrap content-start gap-1.5 overflow-y-auto overscroll-contain [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-kumo-line [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5"
							onClick={(event) => {
								if (isCreating || (event.target as HTMLElement).closest("button")) return;
								openPicker(fieldTriggerRef.current);
							}}
						>
							{selectedOptions.map((option) => (
								<span
									key={option.term.id}
									role="listitem"
									className="flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm bg-kumo-tint ps-2 text-base ring-1 ring-inset ring-kumo-hairline"
								>
									<span className="min-w-0 truncate">{option.term.label}</span>
									<TermLocaleBadge term={option.term} entryLocale={entryLocale} />
									<Button
										type="button"
										variant="ghost"
										size="xs"
										shape="square"
										className="h-6 w-6 min-w-6 bg-transparent"
										disabled={isCreating}
										aria-label={t`Remove ${option.term.label}`}
										onClick={(event) => {
											event.stopPropagation();
											toggleTerm(option.term.id);
										}}
										icon={<X size={10} aria-hidden="true" />}
									/>
								</span>
							))}
						</div>
					) : null}
				</LayerCard>
			</div>

			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					anchor={anchorRef}
					align="start"
					side="bottom"
					sideOffset={6}
					positionMethod="fixed"
					className="z-[100]"
				>
					<PopoverPrimitive.Popup
						initialFocus={false}
						finalFocus={false}
						style={{ width: "var(--anchor-width)" }}
						className="max-w-(--available-width) origin-(--transform-origin) outline-none transition-[transform,scale,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
					>
						<LayerCard className="p-0 shadow-md">
							<PopoverPrimitive.Title className="sr-only">
								{t`Choose ${label}`}
							</PopoverPrimitive.Title>
							<div className="p-1.5 pb-0">
								<InputGroup className="w-full" disabled={isCreating}>
									<InputGroup.Addon>
										<MagnifyingGlass size={16} aria-hidden="true" />
									</InputGroup.Addon>
									<InputGroup.Input
										ref={inputRef}
										id={inputId}
										role="searchbox"
										aria-label={t`Search ${label}`}
										aria-controls={listId}
										value={input}
										onChange={(event) => {
											pastedDelimitedInputRef.current = null;
											setInput(event.target.value);
											setActiveIndex(0);
										}}
										onPaste={(event) => {
											const pastedValue = event.clipboardData.getData("text");
											if (!allowDelimitedValues || !PASTED_LINE_BREAK.test(pastedValue)) return;
											event.preventDefault();
											const start = event.currentTarget.selectionStart ?? input.length;
											const end = event.currentTarget.selectionEnd ?? input.length;
											const rawValue = `${input.slice(0, start)}${pastedValue}${input.slice(end)}`;
											pastedDelimitedInputRef.current = rawValue;
											setInput(rawValue.replace(TERM_VALUE_DISPLAY_SEPARATOR, ", "));
											setActiveIndex(0);
										}}
										onKeyDown={handleInputKeyDown}
										placeholder={t`Search ${label}…`}
										className="text-base font-normal"
									/>
								</InputGroup>
							</div>
							{createError ? (
								<p role="alert" className="px-3 pt-1.5 text-xs leading-4 text-kumo-danger">
									{createError.message}
								</p>
							) : null}
							<div
								id={listId}
								role="group"
								aria-label={t`${label} options`}
								className="emdash-auto-scrollbar max-h-56 overflow-y-auto overscroll-contain p-1.5"
							>
								{visibleOptions.length > 0 ? (
									visibleOptions.map((option, index) => (
										<div
											key={option.term.id}
											className={cn(
												"rounded px-2 py-1.5 hover:bg-kumo-tint",
												activeIndex === index && "bg-kumo-tint",
											)}
											onMouseEnter={() => setActiveIndex(index)}
											onFocus={() => setActiveIndex(index)}
											onKeyDown={(event) => handleOptionKeyDown(event, index, option.term.id)}
										>
											<Checkbox
												ref={(node) => {
													optionRefs.current[index] = node;
												}}
												checked={selectedIds.has(option.term.id)}
												onCheckedChange={() => toggleTerm(option.term.id)}
												label={
													<span
														className="flex min-w-0 items-center gap-2"
														style={{ paddingInlineStart: `${option.depth}rem` }}
													>
														<span className="min-w-0 truncate">{option.term.label}</span>
														<TermLocaleBadge term={option.term} entryLocale={entryLocale} />
													</span>
												}
											/>
										</div>
									))
								) : (
									<p className="px-2 py-2 text-xs leading-4 text-kumo-subtle">
										{t`No ${label} found.`}
									</p>
								)}
							</div>

							{canCreate ? (
								<div className="border-t border-kumo-hairline p-1.5">
									<Button
										type="button"
										variant="ghost"
										className="h-9 w-full justify-start px-2 text-kumo-subtle"
										disabled={isCreating || (Boolean(trimmedInput) && !canCreateInput)}
										loading={isCreating}
										onClick={handleCreate}
										icon={<Plus size={16} aria-hidden="true" />}
									>
										{trimmedInput ? t`Create "${trimmedInput}"` : t`Create a new ${singularLabel}`}
									</Button>
								</div>
							) : null}

							<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-kumo-hairline bg-kumo-elevated px-3 py-2 text-xs leading-4 text-kumo-subtle">
								<span className="flex items-center gap-1.5 whitespace-nowrap">
									<kbd className="inline-flex min-w-5 items-center justify-center rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-xs leading-4 text-kumo-default">
										↑ ↓
									</kbd>
									{t`Navigate`}
								</span>
								<span className="flex items-center gap-1.5 whitespace-nowrap">
									<kbd className="inline-flex min-w-5 items-center justify-center rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-xs leading-4 text-kumo-default">
										↵
									</kbd>
									{t`Toggle`}
								</span>
								<span className="ms-auto flex items-center gap-1.5 whitespace-nowrap">
									<kbd className="inline-flex min-w-5 items-center justify-center rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-xs leading-4 text-kumo-default">
										{t`Esc`}
									</kbd>
									{t`Close`}
								</span>
							</div>
						</LayerCard>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
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
	const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
	const [partialCreateError, setPartialCreateError] = React.useState<Error | null>(null);
	const selectedIdsRef = React.useRef(selectedIds);

	const saveMutation = useMutation({
		scope: {
			id: `taxonomy:${collection}:${entryId ?? "new"}:${taxonomy.name}:${entryLocale ?? "default"}`,
		},
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
	const updateSelection = (newSelected: Set<string>) => {
		selectedIdsRef.current = newSelected;
		setSelectedIds(newSelected);
		const termIdsArray = [...newSelected];
		onChange?.(termIdsArray);
		if (entryId) {
			saveMutation.mutate(termIdsArray);
		}
	};

	const createTermMutation = useMutation({
		mutationFn: async ({ labels, matchedIds }: { labels: string[]; matchedIds: string[] }) => {
			const settled: PromiseSettledResult<TaxonomyTerm>[] = [];
			for (const label of labels) {
				try {
					const term = await createTerm(taxonomy.name, {
						label,
						// Create the term in the entry's locale so it resolves on this entry.
						...(entryLocale ? { locale: entryLocale } : {}),
					});
					settled.push({ status: "fulfilled", value: term });
				} catch (reason) {
					settled.push({ status: "rejected", reason });
				}
			}
			const newTerms: TaxonomyTerm[] = [];
			const failedLabels: string[] = [];
			let firstError: unknown;

			settled.forEach((result, index) => {
				if (result.status === "fulfilled") {
					newTerms.push({ ...result.value, children: result.value.children ?? [] });
					return;
				}
				const label = labels[index];
				if (label) failedLabels.push(label);
				firstError ??= result.reason;
			});

			if (newTerms.length === 0 && matchedIds.length === 0 && firstError) {
				throw firstError instanceof Error ? firstError : new Error(t`Failed to create term`);
			}
			return { newTerms, failedLabels };
		},
		onMutate: () => setPartialCreateError(null),
		onSuccess: ({ newTerms, failedLabels }, { matchedIds }) => {
			queryClient.setQueryData<TaxonomyTerm[]>(
				["taxonomy-terms", taxonomy.name, entryLocale, { includeCounts: false }],
				(current = []) => [
					...current.filter((term) => !newTerms.some((newTerm) => newTerm.id === term.id)),
					...newTerms,
				],
			);
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomy.name, entryLocale],
			});
			const newSelected = new Set(selectedIdsRef.current);
			matchedIds.forEach((termId) => newSelected.add(termId));
			newTerms.forEach((term) => newSelected.add(term.id));
			updateSelection(newSelected);
			if (failedLabels.length > 0) {
				setPartialCreateError(new Error(t`Failed to create ${failedLabels.join(", ")}`));
			}
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

	// Sync selected IDs from entry terms
	React.useEffect(() => {
		const next = new Set(entryTerms.map((term) => term.id));
		for (const assignment of unresolved) {
			const source = assignment.translations[0];
			if (source) next.add(source.id);
		}
		selectedIdsRef.current = next;
		setSelectedIds(next);
	}, [entryTerms, unresolved]);

	const activeUnresolved = unresolved.filter((assignment) => {
		const source = assignment.translations[0];
		return source ? selectedIds.has(source.id) : false;
	});

	const handleToggle = (termId: string) => {
		const newSelected = new Set(selectedIdsRef.current);
		if (newSelected.has(termId)) newSelected.delete(termId);
		else newSelected.add(termId);
		updateSelection(newSelected);
	};

	const handlePickerChange = (termIds: string[]) => {
		const availableIds = new Set(flattenTerms(terms).map(({ term }) => term.id));
		const newSelected = new Set(
			[...selectedIdsRef.current].filter((termId) => !availableIds.has(termId)),
		);
		termIds.forEach((termId) => newSelected.add(termId));
		updateSelection(newSelected);
	};

	return (
		<div className="grid min-w-0 gap-2">
			<TaxonomyTermPicker
				terms={terms}
				selectedIds={selectedIds}
				onChange={handlePickerChange}
				onCreate={(labels, matchedIds) => createTermMutation.mutate({ labels, matchedIds })}
				isCreating={createTermMutation.isPending}
				createError={canManageTaxonomies ? (partialCreateError ?? createTermMutation.error) : null}
				label={taxonomy.label}
				entryLocale={resolvedEntryLocale}
				canCreate={canManageTaxonomies}
				allowDelimitedValues={!taxonomy.hierarchical}
				singularLabel={taxonomy.labelSingular || taxonomy.label}
			/>
			{activeUnresolved.map((assignment) => {
				const source = assignment.translations[0];
				if (!source) return null;
				return (
					<div
						key={assignment.translationGroup}
						className="space-y-2 rounded-lg border border-kumo-warning/50 bg-kumo-warning-tint p-3"
					>
						<p className="text-base font-medium text-kumo-warning">{t`Unresolved assignment`}</p>
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
		<div className={cn("grid gap-3", className)}>
			<Text as="h3" DANGEROUS_className="font-semibold">
				{t`Taxonomies`}
			</Text>
			<div className="grid gap-4">
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
	);
}
