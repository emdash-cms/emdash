import {
	Badge,
	Button,
	DropdownMenu,
	LayerCard,
	Loader,
	Select,
	Table,
	Toast,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { DotsThree, IdentificationCard, Pencil, Plus, Trash } from "@phosphor-icons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { BylineFormDialog, type BylineFormValues } from "../components/BylineFormDialog.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { LocaleSwitcher, useI18nConfig } from "../components/LocaleSwitcher.js";
import { RouterLinkButton } from "../components/RouterLinkButton.js";
import { BYLINE_SCHEMA_NAV_ITEM } from "../components/Sidebar.js";
import { TableToolbar, TableToolbarSearch } from "../components/TableToolbar.js";
import { TranslationsPanel } from "../components/TranslationsPanel.js";
import {
	createByline,
	createBylineTranslation,
	deleteByline,
	fetchBylineTranslations,
	fetchBylines,
	updateByline,
	type BylineSummary,
} from "../lib/api";
import { fetchManifest } from "../lib/api/client.js";
import { useCurrentUser } from "../lib/api/current-user.js";
import { useDebouncedValue } from "../lib/hooks.js";

const BYLINE_NAME_SEPARATOR = /\s+/;
const BYLINE_INITIAL_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface LoadMoreSnapshot {
	search: string;
	guestFilter: "all" | "guest" | "linked";
	locale: string | undefined;
	cursor: string;
}

/**
 * True when the load-more snapshot still matches the current filter state.
 * Used to discard appends from requests whose filters have changed mid-flight.
 */
export function loadMoreSnapshotMatches(
	snapshot: LoadMoreSnapshot,
	current: Omit<LoadMoreSnapshot, "cursor">,
): boolean {
	return (
		snapshot.search === current.search &&
		snapshot.guestFilter === current.guestFilter &&
		snapshot.locale === current.locale
	);
}

function BylineMonogram({ name }: { name: string }) {
	const initials = name
		.trim()
		.split(BYLINE_NAME_SEPARATOR)
		.slice(0, 2)
		.map((part) => BYLINE_INITIAL_SEGMENTER.segment(part).containing(0)?.segment ?? "")
		.join("")
		.toLocaleUpperCase();

	return (
		<span
			aria-hidden="true"
			className="flex size-10 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-sm font-semibold text-kumo-strong ring-1 ring-kumo-line"
		>
			{initials || <IdentificationCard className="size-5" />}
		</span>
	);
}

export function BylinesPage() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const navigate = useNavigate();
	const { locale: routeLocale } = useSearch({ from: "/_admin/bylines" });
	const [search, setSearch] = React.useState("");
	// Debounce the search before it feeds the query key/fetch so typing stays
	// responsive — the input stays bound to raw `search` while only the
	// debounced value drives refetches.
	const debouncedSearch = useDebouncedValue(search, 300);
	const [guestFilter, setGuestFilter] = React.useState<"all" | "guest" | "linked">("all");
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [formOpen, setFormOpen] = React.useState(false);
	const [deleteTarget, setDeleteTarget] = React.useState<BylineSummary | null>(null);
	const [allItems, setAllItems] = React.useState<BylineSummary[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined);

	// Manifest powers the locale switcher: the configured locales + default
	// locale come from the site's emdash config, exposed on the manifest.
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const i18n = useI18nConfig(manifest);
	const isMultiLocale = !!i18n && i18n.locales.length > 1;

	const { data: currentUser } = useCurrentUser();
	const canManageBylineSchema = (currentUser?.role ?? 0) >= BYLINE_SCHEMA_NAV_ITEM.minRole;
	// `activeLocale` is the URL search param when present, else the default.
	// Picker on a translated post can be expected to scope to the post's
	// locale (Phase 4 wires that up); for the bylines manager itself the
	// active locale just filters the list and seeds new bylines.
	const activeLocale = routeLocale ?? i18n?.defaultLocale ?? undefined;

	const handleLocaleChange = (locale: string) => {
		void navigate({
			to: "/bylines",
			search: { locale: locale || undefined },
		});
		// Switching locales invalidates the previously-selected byline (it
		// belongs to a different list); clear selection so the editor opens
		// in "create" mode at the new locale.
		setSelectedId(null);
	};

	const { data, isLoading, error } = useQuery({
		queryKey: ["bylines", debouncedSearch, guestFilter, activeLocale ?? null],
		queryFn: () =>
			fetchBylines({
				search: debouncedSearch || undefined,
				isGuest: guestFilter === "all" ? undefined : guestFilter === "guest",
				locale: activeLocale,
				limit: 50,
			}),
		// Keep the previous results on screen while a new search/filter query
		// loads. Without this, changing the query key drops `data` to
		// `undefined`, the `isLoading && !data` gate re-engages, and the whole
		// page collapses into the full-page loader on every settled keystroke —
		// the focus-losing "reload" reported in #1220 that the debounce alone
		// only reduced in frequency. Matches ContentEditor's search pattern.
		placeholderData: keepPreviousData,
	});

	// Reset accumulated items when filters change
	React.useEffect(() => {
		if (data) {
			setAllItems(data.items);
			setNextCursor(data.nextCursor);
		}
	}, [data]);

	// Snapshot filters at click-time and discard the response if the user
	// changed any of them while the request was in flight — otherwise stale
	// pages from a different filter set get appended to the visible list.
	const loadMoreMutation = useMutation({
		mutationFn: async (snapshot: LoadMoreSnapshot) => {
			const result = await fetchBylines({
				search: snapshot.search || undefined,
				isGuest: snapshot.guestFilter === "all" ? undefined : snapshot.guestFilter === "guest",
				locale: snapshot.locale,
				limit: 50,
				cursor: snapshot.cursor,
			});
			return { result, snapshot };
		},
		onSuccess: ({ result, snapshot }) => {
			if (
				!loadMoreSnapshotMatches(snapshot, {
					search: debouncedSearch,
					guestFilter,
					locale: activeLocale,
				})
			) {
				return;
			}
			setAllItems((prev) => [...prev, ...result.items]);
			setNextCursor(result.nextCursor);
		},
	});

	const items = allItems;
	// The selected byline may be a sibling of the open byline reached via
	// TranslationsPanel, which isn't in the list; the form dialog loads it.
	const selected = items.find((item) => item.id === selectedId) ?? null;

	// Translations: only fetched when a multi-locale install has a byline
	// open. The panel renders one row per configured locale, with Translate
	// or Edit buttons depending on which siblings exist.
	const { data: translationsData } = useQuery({
		queryKey: ["byline-translations", selectedId],
		queryFn: () =>
			selectedId ? fetchBylineTranslations(selectedId) : Promise.resolve({ items: [] }),
		enabled: !!selectedId && isMultiLocale,
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteByline(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			setFormOpen(false);
			setSelectedId(null);
			setDeleteTarget(null);
			toastManager.add({ title: t`Byline deleted` });
		},
	});

	// Translate-this-byline action: creates a sibling row in the target locale
	// joined to the same translation_group. We track `pendingTranslationLocale`
	// so the TranslationsPanel can disable the right button while in flight.
	const [pendingTranslationLocale, setPendingTranslationLocale] = React.useState<string | null>(
		null,
	);
	const translateMutation = useMutation({
		mutationFn: (targetLocale: string) => {
			if (!selectedId) throw new Error("No byline selected");
			setPendingTranslationLocale(targetLocale);
			return createBylineTranslation(selectedId, { locale: targetLocale });
		},
		onSettled: () => {
			setPendingTranslationLocale(null);
		},
		onSuccess: (created) => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			if (selectedId) {
				void queryClient.invalidateQueries({
					queryKey: ["byline-translations", selectedId],
				});
			}
			// Switch the admin locale to the new sibling's locale and open it
			// in the editor — same flow as menus/taxonomies after Translate.
			void navigate({
				to: "/bylines",
				search: { locale: created.locale },
			});
			setSelectedId(created.id);
		},
	});

	if (isLoading && !data) {
		return (
			<div className="flex items-center justify-center min-h-[30vh]">
				<Loader />
			</div>
		);
	}

	if (error) {
		return <div className="text-kumo-danger">{t`Failed to load bylines: ${error.message}`}</div>;
	}

	const openCreate = () => {
		setSelectedId(null);
		translateMutation.reset();
		setFormOpen(true);
	};
	const openEdit = (item: BylineSummary) => {
		setSelectedId(item.id);
		translateMutation.reset();
		setFormOpen(true);
	};
	const closeForm = () => {
		setFormOpen(false);
		setSelectedId(null);
		translateMutation.reset();
	};
	const saveByline = (values: BylineFormValues) =>
		selectedId
			? updateByline(selectedId, values)
			: createByline({ ...values, locale: activeLocale });
	const handleBylineSaved = (saved: BylineSummary) => {
		if (selectedId) {
			setAllItems((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
		}
		void queryClient.invalidateQueries({ queryKey: ["bylines"] });
		setFormOpen(false);
		setSelectedId(null);
		toastManager.add({ title: selectedId ? t`Byline updated` : t`Byline created` });
	};

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-center justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold leading-tight">{t`Bylines`}</h1>
					<p className="text-sm text-kumo-subtle">
						{t`Manage the people and teams credited on your content.`}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{isMultiLocale && i18n && activeLocale && (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={handleLocaleChange}
						/>
					)}
					{canManageBylineSchema && (
						<RouterLinkButton
							to={BYLINE_SCHEMA_NAV_ITEM.to}
							variant="secondary"
							icon={<BYLINE_SCHEMA_NAV_ITEM.icon aria-hidden="true" />}
						>
							{t`Byline schema`}
						</RouterLinkButton>
					)}
					<Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={openCreate}>
						{t`New byline`}
					</Button>
				</div>
			</header>

			<TableToolbar>
				<TableToolbarSearch
					size="base"
					placeholder={t`Search bylines`}
					aria-label={t`Search bylines`}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<Select
					size="base"
					aria-label={t`Filter byline type`}
					value={guestFilter}
					onValueChange={(value) => setGuestFilter((value as "all" | "guest" | "linked") ?? "all")}
					items={{
						all: t`All bylines`,
						guest: t`Guest only`,
						linked: t`Non-guest`,
					}}
					className="w-full sm:w-44"
				/>
			</TableToolbar>

			{items.length > 0 ? (
				<LayerCard className="p-0">
					<div className="overflow-x-auto">
						<Table className="text-start">
							<Table.Header variant="compact">
								<Table.Row>
									<Table.Head className="text-start">{t`Byline`}</Table.Head>
									<Table.Head className="w-32 text-start">{t`Type`}</Table.Head>
									<Table.Head className="hidden w-48 text-start lg:table-cell">
										{t`Website`}
									</Table.Head>
									<Table.Head className="w-24 text-end">
										<span className="sr-only">{t`Actions`}</span>
									</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{items.map((item) => (
									<Table.Row key={item.id} className="hover:bg-kumo-tint/25">
										<Table.Cell>
											<div className="flex min-w-0 items-center gap-3 py-1">
												<BylineMonogram name={item.displayName} />
												<div className="min-w-0">
													<span dir="auto" className="block font-medium">
														{item.displayName}
													</span>
													<bdi dir="ltr" className="block text-xs text-kumo-subtle">
														/{item.slug}
													</bdi>
													{item.bio && (
														<span
															dir="auto"
															className="block max-w-lg truncate text-sm text-kumo-subtle"
														>
															{item.bio}
														</span>
													)}
												</div>
											</div>
										</Table.Cell>
										<Table.Cell>
											<Badge variant={item.userId && !item.isGuest ? "success" : "secondary"}>
												{item.isGuest ? t`Guest` : item.userId ? t`Linked user` : t`Unlinked`}
											</Badge>
										</Table.Cell>
										<Table.Cell className="hidden lg:table-cell">
											{item.websiteUrl ? (
												<bdi
													dir="ltr"
													className="block max-w-44 truncate text-sm text-kumo-subtle"
													title={item.websiteUrl}
												>
													{item.websiteUrl}
												</bdi>
											) : (
												<span className="text-kumo-subtle">—</span>
											)}
										</Table.Cell>
										<Table.Cell>
											<div className="flex justify-end gap-1">
												<Button
													variant="ghost"
													size="sm"
													shape="square"
													icon={<Pencil aria-hidden="true" />}
													aria-label={t`Edit ${item.displayName}`}
													onClick={() => openEdit(item)}
												/>
												<DropdownMenu>
													<DropdownMenu.Trigger
														render={
															<Button
																type="button"
																variant="ghost"
																size="sm"
																shape="square"
																icon={<DotsThree aria-hidden="true" />}
																aria-label={t`More actions for ${item.displayName}`}
															/>
														}
													/>
													<DropdownMenu.Content
														align="end"
														className="origin-(--transform-origin) transition-[transform,scale,opacity] duration-150 data-ending-style:scale-90 data-ending-style:opacity-0 data-instant:duration-0 data-starting-style:scale-90 data-starting-style:opacity-0 motion-reduce:transition-none"
													>
														<DropdownMenu.Item
															variant="danger"
															icon={<Trash className="me-2 size-4" aria-hidden="true" />}
															aria-label={t`Delete byline ${item.displayName}`}
															onClick={() => setDeleteTarget(item)}
														>
															{t`Delete byline`}
														</DropdownMenu.Item>
													</DropdownMenu.Content>
												</DropdownMenu>
											</div>
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				</LayerCard>
			) : (
				<LayerCard className="flex min-h-60 flex-col items-center justify-center gap-2 p-6 text-center">
					<IdentificationCard
						size={32}
						className="text-kumo-subtle opacity-60"
						aria-hidden="true"
					/>
					<h2 className="text-base font-medium">
						{search || guestFilter !== "all" ? t`No matching bylines` : t`No bylines yet`}
					</h2>
					<p className="text-sm text-kumo-subtle">
						{search || guestFilter !== "all"
							? t`Try a different search or filter.`
							: t`Create a profile for someone credited on your content.`}
					</p>
					<Button
						variant="secondary"
						size="sm"
						className="mt-2"
						onClick={
							search || guestFilter !== "all"
								? () => {
										setSearch("");
										setGuestFilter("all");
									}
								: openCreate
						}
					>
						{search || guestFilter !== "all" ? t`Clear filters` : t`New byline`}
					</Button>
				</LayerCard>
			)}

			{nextCursor && (
				<div className="flex justify-center">
					<Button
						variant="secondary"
						onClick={() =>
							loadMoreMutation.mutate({
								search: debouncedSearch,
								guestFilter,
								locale: activeLocale,
								cursor: nextCursor,
							})
						}
						disabled={loadMoreMutation.isPending}
					>
						{loadMoreMutation.isPending ? t`Loading...` : t`Load more`}
					</Button>
				</div>
			)}

			<BylineFormDialog
				open={formOpen}
				onOpenChange={(open) => {
					if (!open && !deleteTarget) closeForm();
				}}
				bylineId={selectedId}
				byline={selected}
				onSubmit={saveByline}
				onSaved={handleBylineSaved}
				error={translateMutation.error}
				onDelete={setDeleteTarget}
				renderExtra={(byline) =>
					isMultiLocale && i18n ? (
						<div className="border-t border-kumo-line pt-5">
							<TranslationsPanel
								locales={i18n.locales}
								defaultLocale={i18n.defaultLocale}
								currentLocale={byline.locale}
								translations={translationsData?.items ?? []}
								onOpen={(summary) => {
									void navigate({
										to: "/bylines",
										search: { locale: summary.locale },
									});
									setSelectedId(summary.id);
								}}
								onCreate={(locale) => translateMutation.mutate(locale)}
								pendingLocale={pendingTranslationLocale}
							/>
						</div>
					) : null
				}
			/>

			<ConfirmDialog
				open={!!deleteTarget}
				role="alertdialog"
				onClose={() => {
					setDeleteTarget(null);
					deleteMutation.reset();
				}}
				title={t`Delete ${deleteTarget?.displayName ?? t`byline`}?`}
				description={t`This removes the byline profile. Content byline links are removed and lead pointers are cleared.`}
				confirmLabel={t`Delete byline`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
			/>
		</div>
	);
}
