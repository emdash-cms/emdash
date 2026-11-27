import {
	Button,
	Checkbox,
	Input,
	LayerDialog,
	Select,
	SkeletonLine,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	createMenuItem,
	fetchContentList,
	type CreateMenuItemInput,
	type MenuItem,
} from "../../lib/api";
import { guardUnsavedInput } from "../../lib/dialog-form.js";
import { getEntryTitle } from "../../lib/entryTitle.js";
import { useDebouncedValue } from "../../lib/hooks.js";
import { cn } from "../../lib/utils.js";
import { ContentStatusLabel } from "../ContentStatusBadge.js";
import { DialogError, getMutationError } from "../DialogError.js";
import { labelProblem, urlProblem } from "./menu-item-form.js";
import {
	flattenTerms,
	termsQueryOptions,
	useManifest,
	useTaxonomyDefs,
} from "./menu-item-target.js";
import { flattenMenu, INDENT_WIDTH, MAX_DEPTH } from "./menu-tree.js";

const SOURCE_STORAGE_KEY = "emdash:menus:add-source";
const TOP_LEVEL = "__top__";

interface Row {
	key: string;
	title: string;
	detail?: string;
	draft?: boolean;
	input: CreateMenuItemInput;
}

/** An item waiting in the dialog to be created. */
type Staged = Pick<Row, "key" | "title" | "input">;

function readStoredSource(): string | null {
	try {
		return localStorage.getItem(SOURCE_STORAGE_KEY);
	} catch {
		return null;
	}
}

function storeSource(source: string) {
	try {
		localStorage.setItem(SOURCE_STORAGE_KEY, source);
	} catch {
		// Private browsing can refuse storage; the source just isn't remembered.
	}
}

function contentItemType(collection: string) {
	return collection === "pages" ? "page" : collection === "posts" ? "post" : "collection";
}

function SkeletonRows() {
	return (
		<div aria-hidden="true">
			{[0, 1, 2, 3, 4, 5].map((row) => (
				<div key={row} className="flex h-11 items-center gap-3 px-3">
					<span className="size-4 shrink-0 rounded-sm bg-kumo-tint" />
					<div className="flex-1">
						<SkeletonLine minWidth={30} maxWidth={60} />
					</div>
				</div>
			))}
		</div>
	);
}

function ListMessage({ children }: { children: React.ReactNode }) {
	return (
		<div className="grid h-full place-items-center px-6 text-center text-base text-kumo-subtle">
			<p>{children}</p>
		</div>
	);
}

function PickRow({
	row,
	checked,
	onToggle,
}: {
	row: Pick<Row, "key" | "title" | "detail" | "draft">;
	checked: boolean;
	onToggle: () => void;
}) {
	return (
		<label className="flex h-11 cursor-pointer items-center gap-3 px-3 text-base [@media(hover:hover)]:hover:bg-kumo-tint/50">
			<Checkbox checked={checked} onCheckedChange={onToggle} aria-label={row.title} />
			<span className="min-w-0 shrink-0 truncate max-w-[60%]">{row.title}</span>
			{row.detail && (
				<bdi dir="ltr" className="min-w-0 flex-1 truncate text-kumo-subtle">
					{row.detail}
				</bdi>
			)}
			{row.draft && (
				<ContentStatusLabel state="draft" className="ms-auto shrink-0 text-kumo-subtle" />
			)}
		</label>
	);
}

export function AddMenuItemsDialog({
	open,
	onOpenChange,
	menuName,
	menuLocale,
	items,
	initialParentId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	menuName: string;
	menuLocale?: string;
	items: MenuItem[];
	/** Preselects "Add to" when the dialog opens from a row's "Add item inside". */
	initialParentId: string | null;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const manifest = useManifest();
	const taxonomies = useTaxonomyDefs(menuLocale);

	const collections = React.useMemo(
		() =>
			Object.entries(manifest?.collections ?? {})
				.filter(([, collection]) => !collection.hidden)
				.map(([slug, collection]) => ({ slug, ...collection })),
		[manifest],
	);

	const sources = React.useMemo(
		() => [
			...collections.map((collection) => ({
				value: `collection:${collection.slug}`,
				label: collection.label,
			})),
			...taxonomies.map((taxonomy) => ({
				value: `taxonomy:${taxonomy.name}`,
				label: taxonomy.label,
			})),
			{ value: "archive", label: t`Archive pages` },
			{ value: "custom", label: t`Custom link` },
			{ value: "heading", label: t`Heading` },
		],
		[collections, taxonomies, t],
	);

	const [chosenSource, setChosenSource] = React.useState(readStoredSource);
	const source =
		sources.find((candidate) => candidate.value === chosenSource)?.value ??
		sources[0]?.value ??
		"custom";
	const [sourceKind, sourceName = ""] = source.split(":") as [string, string?];

	const [search, setSearch] = React.useState("");
	const debouncedSearch = useDebouncedValue(search.trim(), 250);
	const [staged, setStaged] = React.useState<Staged[]>([]);
	const [parentId, setParentId] = React.useState(initialParentId ?? TOP_LEVEL);
	const [customLabel, setCustomLabel] = React.useState("");
	const [customUrl, setCustomUrl] = React.useState("");
	const [customSubmitted, setCustomSubmitted] = React.useState(false);
	const customCounter = React.useRef(0);
	const labelRef = React.useRef<HTMLInputElement>(null);
	const urlRef = React.useRef<HTMLInputElement>(null);

	const changeSource = (value: string) => {
		setChosenSource(value);
		storeSource(value);
		setSearch("");
		setCustomSubmitted(false);
	};

	const contentQuery = useQuery({
		queryKey: ["menu-add-content", sourceName, debouncedSearch, menuLocale],
		queryFn: () =>
			fetchContentList(sourceName, {
				limit: 50,
				search: debouncedSearch || undefined,
				locale: menuLocale,
			}),
		enabled: open && sourceKind === "collection",
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === sourceName ? previous : undefined,
	});

	const termsQuery = useQuery({
		...termsQueryOptions(sourceName, menuLocale),
		enabled: open && sourceKind === "taxonomy",
	});

	const needle = debouncedSearch.toLocaleLowerCase();
	const rows: Row[] = React.useMemo(() => {
		if (sourceKind === "collection") {
			const titleField = manifest?.collections[sourceName]?.titleField;
			return (contentQuery.data?.items ?? []).map((entry) => {
				const title = getEntryTitle(entry, titleField);
				return {
					key: `entry:${sourceName}:${entry.id}`,
					title,
					detail: entry.slug ? `/${entry.slug}` : undefined,
					draft: entry.status !== "published",
					input: {
						type: contentItemType(sourceName),
						label: title,
						referenceCollection: sourceName,
						referenceId: entry.translationGroup ?? entry.id,
					},
				};
			});
		}
		if (sourceKind === "taxonomy") {
			return flattenTerms(termsQuery.data ?? [])
				.filter(({ term }) => !needle || term.label.toLocaleLowerCase().includes(needle))
				.map(({ term }) => ({
					key: `term:${sourceName}:${term.id}`,
					title: term.label,
					detail: `/${term.slug}`,
					input: {
						type: "taxonomy",
						label: term.label,
						referenceCollection: sourceName,
						referenceId: term.translationGroup ?? term.id,
					},
				}));
		}
		if (sourceKind === "archive") {
			return collections
				.filter(
					(collection) =>
						!needle ||
						collection.label.toLocaleLowerCase().includes(needle) ||
						collection.slug.includes(needle),
				)
				.map((collection) => ({
					key: `archive:${collection.slug}`,
					title: t`All ${collection.label}`,
					detail: `/${collection.slug}/`,
					input: {
						type: "collection",
						label: collection.label,
						referenceCollection: collection.slug,
					},
				}));
		}
		return [];
	}, [
		sourceKind,
		sourceName,
		manifest,
		contentQuery.data,
		termsQuery.data,
		collections,
		needle,
		t,
	]);

	const isLoadingList =
		(sourceKind === "collection" && contentQuery.isLoading) ||
		(sourceKind === "taxonomy" && termsQuery.isLoading);
	const listError =
		(sourceKind === "collection" && contentQuery.error) ||
		(sourceKind === "taxonomy" && termsQuery.error);

	const stagedKeys = new Set(staged.map((entry) => entry.key));
	const toggle = (row: Staged) =>
		setStaged((previous) =>
			previous.some((entry) => entry.key === row.key)
				? previous.filter((entry) => entry.key !== row.key)
				: [...previous, { key: row.key, title: row.title, input: row.input }],
		);

	const customProblems = {
		label: labelProblem(customLabel),
		url: sourceKind === "custom" ? urlProblem(customUrl) : undefined,
	};
	const customErrors: Partial<typeof customProblems> = customSubmitted ? customProblems : {};

	const stageCustom = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (customProblems.label || customProblems.url) {
			setCustomSubmitted(true);
			(customProblems.label ? labelRef : urlRef).current?.focus();
			return;
		}
		customCounter.current += 1;
		const label = customLabel.trim();
		const url = customUrl.trim();
		setStaged((previous) => [
			...previous,
			{
				key: `${sourceKind}:${customCounter.current}`,
				title: label,
				input:
					sourceKind === "custom"
						? { type: "custom", label, customUrl: url }
						: { type: "custom", label },
			},
		]);
		setCustomLabel("");
		setCustomUrl("");
		setCustomSubmitted(false);
		labelRef.current?.focus();
	};

	const parentOptions = React.useMemo(
		() => [
			{ value: TOP_LEVEL, label: t`Top level`, depth: 0 },
			...flattenMenu(items)
				.filter((entry) => entry.depth < MAX_DEPTH - 1)
				.map((entry) => ({ value: entry.id, label: entry.item.label, depth: entry.depth + 1 })),
		],
		[items, t],
	);
	const parentValue = parentOptions.some((option) => option.value === parentId)
		? parentId
		: TOP_LEVEL;

	const addMutation = useMutation({
		mutationFn: async (toAdd: Staged[]) => {
			const added: string[] = [];
			try {
				for (const entry of toAdd) {
					// oxlint-disable-next-line no-await-in-loop -- items are appended in order
					await createMenuItem(
						menuName,
						{ ...entry.input, parentId: parentValue === TOP_LEVEL ? undefined : parentValue },
						{ locale: menuLocale },
					);
					added.push(entry.key);
				}
			} finally {
				if (added.length > 0) {
					void queryClient.invalidateQueries({ queryKey: ["menu", menuName] });
					setStaged((previous) => previous.filter((entry) => !added.includes(entry.key)));
				}
			}
			return added.length;
		},
		onSuccess: (count) => {
			onOpenChange(false);
			toastManager.add({
				title: plural(count, { one: "Added # item", other: "Added # items" }),
			});
		},
	});

	const count = staged.length;
	const unsaved = count > 0 || customLabel !== "" || customUrl !== "";
	const isCustomSource = sourceKind === "custom" || sourceKind === "heading";
	const stagedHere = staged.filter((entry) => entry.key.startsWith(`${sourceKind}:`));

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(unsaved, onOpenChange)}
			dismissDisabled={addMutation.isPending}
		>
			<LayerDialog.Content size="lg">
				<LayerDialog.Title>{t`Add items`}</LayerDialog.Title>
				<LayerDialog.Description>
					{t`Pick from any source, then add them all at once.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<div className="grid gap-4">
						<div className="flex gap-2 max-sm:flex-col">
							<Select
								aria-label={t`Source`}
								className="w-full sm:w-44"
								value={source}
								onValueChange={(value) => value && changeSource(String(value))}
								items={sources}
							/>
							{!isCustomSource && (
								<div className="relative flex-1">
									<MagnifyingGlass
										className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-kumo-subtle"
										aria-hidden="true"
									/>
									<Input
										aria-label={t`Search`}
										placeholder={t`Search`}
										value={search}
										onChange={(event) => setSearch(event.target.value)}
										className="w-full ps-9"
									/>
								</div>
							)}
						</div>

						<div className="h-80 overflow-y-auto rounded-lg ring ring-kumo-line">
							{isCustomSource ? (
								<div className="grid gap-4 p-3">
									<form noValidate onSubmit={stageCustom} className="grid gap-4">
										<div
											className={cn(
												"grid items-start gap-3",
												sourceKind === "custom" && "sm:grid-cols-2",
											)}
										>
											<Input
												ref={labelRef}
												label={t`Label`}
												value={customLabel}
												onChange={(event) => setCustomLabel(event.target.value)}
												error={customErrors.label && t(customErrors.label)}
												aria-invalid={customErrors.label ? true : undefined}
											/>
											{sourceKind === "custom" && (
												<Input
													ref={urlRef}
													dir="ltr"
													label={t`URL`}
													placeholder={t`https://example.com or /about`}
													value={customUrl}
													onChange={(event) => setCustomUrl(event.target.value)}
													error={customErrors.url && t(customErrors.url)}
													aria-invalid={customErrors.url ? true : undefined}
												/>
											)}
										</div>
										<div>
											<Button type="submit" variant="secondary" icon={<Plus aria-hidden="true" />}>
												{t`Add to list`}
											</Button>
										</div>
									</form>
									{stagedHere.length > 0 && (
										<div className="-mx-3 border-t border-kumo-line">
											{stagedHere.map((entry) => (
												<PickRow
													key={entry.key}
													row={{
														key: entry.key,
														title: entry.title,
														detail: entry.input.customUrl,
													}}
													checked
													onToggle={() => toggle(entry)}
												/>
											))}
										</div>
									)}
								</div>
							) : isLoadingList ? (
								<SkeletonRows />
							) : listError ? (
								<ListMessage>{t`Couldn't load this list.`}</ListMessage>
							) : rows.length === 0 ? (
								<ListMessage>
									{debouncedSearch
										? t`Nothing matches “${debouncedSearch}”.`
										: t`Nothing here yet.`}
								</ListMessage>
							) : (
								rows.map((row) => (
									<PickRow
										key={row.key}
										row={row}
										checked={stagedKeys.has(row.key)}
										onToggle={() => toggle(row)}
									/>
								))
							)}
						</div>

						<div className="flex items-center gap-3">
							<span className="shrink-0 text-base text-kumo-subtle">{t`Add to`}</span>
							<Select
								aria-label={t`Add to`}
								className="min-w-0 flex-1 sm:w-56 sm:flex-none"
								value={parentValue}
								onValueChange={(value) => setParentId(value ? String(value) : TOP_LEVEL)}
								items={Object.fromEntries(
									parentOptions.map((option) => [option.value, option.label]),
								)}
							>
								{parentOptions.map((option) => (
									<Select.Option key={option.value} value={option.value}>
										<span
											className="block truncate"
											style={{ paddingInlineStart: option.depth * (INDENT_WIDTH / 2) }}
										>
											<bdi>{option.label}</bdi>
										</span>
									</Select.Option>
								))}
							</Select>
							<span className="ms-auto shrink-0 text-base text-kumo-subtle tabular-nums">
								{plural(count, { one: "# selected", other: "# selected" })}
							</span>
						</div>
						<DialogError message={getMutationError(addMutation.error)} />
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action
						disabled={count === 0 || addMutation.isPending}
						loading={addMutation.isPending}
						onClick={() => addMutation.mutate(staged)}
					>
						{count === 0
							? t`Add items`
							: plural(count, { one: "Add # item", other: "Add # items" })}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
