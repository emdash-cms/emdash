import {
	Badge,
	Button,
	Dialog,
	DropdownMenu,
	Input,
	InputArea,
	LayerCard,
	Loader,
	Select,
	Switch,
	Table,
	Toast,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { DotsThree, IdentificationCard, Pencil, Plus, Trash, X } from "@phosphor-icons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { BylineAvatarField } from "../components/BylineAvatarField.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DialogError, getMutationError } from "../components/DialogError.js";
import { LocaleSwitcher, useI18nConfig } from "../components/LocaleSwitcher.js";
import { RouterLinkButton } from "../components/RouterLinkButton.js";
import { BYLINE_SCHEMA_NAV_ITEM } from "../components/Sidebar.js";
import { TableToolbar, TableToolbarSearch } from "../components/TableToolbar.js";
import { TranslationsPanel } from "../components/TranslationsPanel.js";
import {
	createByline,
	createBylineTranslation,
	deleteByline,
	fetchByline,
	fetchBylineTranslations,
	fetchBylines,
	fetchUsers,
	updateByline,
	type BylineSummary,
	type UserListItem,
} from "../lib/api";
import { listBylineFields, type BylineFieldDefinition } from "../lib/api/byline-fields.js";
import { fetchManifest } from "../lib/api/client.js";
import { useCurrentUser } from "../lib/api/current-user.js";
import { useDebouncedValue } from "../lib/hooks.js";

interface BylineFormState {
	slug: string;
	displayName: string;
	bio: string;
	websiteUrl: string;
	userId: string | null;
	isGuest: boolean;
	/** Media id of the byline's avatar image, or null when unset (#1250). */
	avatarMediaId: string | null;
	/**
	 * Custom-field values keyed by field slug (Phase 6 of #1174). Always
	 * a defined object — `{}` when no fields are registered or the byline
	 * has no stored values — so callers can spread it into update bodies
	 * unconditionally.
	 */
	customFields: Record<string, unknown>;
}

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

function toFormState(byline?: BylineSummary | null): BylineFormState {
	if (!byline) {
		return {
			slug: "",
			displayName: "",
			bio: "",
			websiteUrl: "",
			userId: null,
			isGuest: false,
			avatarMediaId: null,
			customFields: {},
		};
	}

	return {
		slug: byline.slug,
		displayName: byline.displayName,
		bio: byline.bio ?? "",
		websiteUrl: byline.websiteUrl ?? "",
		userId: byline.userId,
		isGuest: byline.isGuest,
		avatarMediaId: byline.avatarMediaId ?? null,
		customFields: byline.customFields ?? {},
	};
}

function getUserLabel(user: UserListItem): string {
	if (user.name) return `${user.name} (${user.email})`;
	return user.email;
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

	const { data: usersData } = useQuery({
		queryKey: ["users", "byline-linking"],
		queryFn: () => fetchUsers({ limit: 100 }),
	});

	const users = usersData?.items ?? [];

	// Phase 6 of #1174: render registered custom fields as inputs in the
	// edit form. List is fetched once per page mount; the registry's
	// version counter invalidates content-side caches but the admin UI
	// just relies on react-query's staleTime for now — admins rarely
	// add/remove fields while another admin is editing a byline, and the
	// next page navigation refetches anyway.
	const { data: customFieldsList, error: customFieldsError } = useQuery({
		queryKey: ["byline-fields"],
		queryFn: listBylineFields,
		staleTime: 60 * 1000,
	});
	const customFieldDefs = customFieldsList?.items ?? [];

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
	// The selected row may live in `allItems` (visible at the active locale)
	// or be a sibling of the open byline reached via TranslationsPanel. Fetch
	// directly by id so the editor stays consistent when the selection
	// crosses locale boundaries.
	const { data: selectedRemote } = useQuery({
		queryKey: ["byline", selectedId],
		queryFn: () => (selectedId ? fetchByline(selectedId) : Promise.resolve(null)),
		enabled: !!selectedId,
	});
	const selected = selectedRemote ?? items.find((item) => item.id === selectedId) ?? null;

	const [form, setForm] = React.useState<BylineFormState>(() => toFormState(null));

	React.useEffect(() => {
		setForm(toFormState(selected));
	}, [selected]);

	// Translations: only fetched when a multi-locale install has a byline
	// open. The panel renders one row per configured locale, with Translate
	// or Edit buttons depending on which siblings exist.
	const { data: translationsData } = useQuery({
		queryKey: ["byline-translations", selectedId],
		queryFn: () =>
			selectedId ? fetchBylineTranslations(selectedId) : Promise.resolve({ items: [] }),
		enabled: !!selectedId && isMultiLocale,
	});

	const createMutation = useMutation({
		mutationFn: () => {
			// Mirrors updateMutation's customFields guard: omit the key
			// when field-defs failed to load so the new row starts blank
			// instead of echoing an empty hydration back.
			const body: Parameters<typeof createByline>[0] = {
				slug: form.slug,
				displayName: form.displayName,
				bio: form.bio || null,
				websiteUrl: form.websiteUrl || null,
				userId: form.userId,
				isGuest: form.isGuest,
				avatarMediaId: form.avatarMediaId,
				locale: activeLocale,
			};
			if (!customFieldsError && Object.keys(form.customFields).length > 0) {
				body.customFields = form.customFields;
			}
			return createByline(body);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			setFormOpen(false);
			setSelectedId(null);
			toastManager.add({ title: t`Byline created` });
		},
	});

	const updateMutation = useMutation({
		mutationFn: () => {
			if (!selectedId) throw new Error("No byline selected");
			// Phase 6 of #1174: forward registered custom-field values
			// when we have field-defs to render them. If the
			// `byline-fields` list failed to load, the inputs aren't
			// rendered so the editor cannot see what they'd be saving;
			// omit the key entirely so the server-side repo skips the
			// customFields branch and preserves stored values verbatim
			// (`undefined` triggers the skip path in
			// `BylineRepository.update`). Sending `form.customFields`
			// would echo the hydrated values back — usually a no-op,
			// but in a "field deleted server-side mid-session" scenario
			// it would surface as a 400, surprising the editor.
			const body: Parameters<typeof updateByline>[1] = {
				slug: form.slug,
				displayName: form.displayName,
				bio: form.bio || null,
				websiteUrl: form.websiteUrl || null,
				userId: form.userId,
				isGuest: form.isGuest,
				avatarMediaId: form.avatarMediaId,
			};
			if (!customFieldsError) {
				body.customFields = form.customFields;
			}
			return updateByline(selectedId, body);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			if (selectedId) {
				void queryClient.invalidateQueries({ queryKey: ["byline", selectedId] });
			}
			setFormOpen(false);
			setSelectedId(null);
			toastManager.add({ title: t`Byline updated` });
		},
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

	const isSaving = createMutation.isPending || updateMutation.isPending;
	const mutationError = createMutation.error || updateMutation.error || translateMutation.error;
	const openCreate = () => {
		setSelectedId(null);
		setForm(toFormState(null));
		createMutation.reset();
		updateMutation.reset();
		translateMutation.reset();
		setFormOpen(true);
	};
	const openEdit = (item: BylineSummary) => {
		setSelectedId(item.id);
		setForm(toFormState(item));
		createMutation.reset();
		updateMutation.reset();
		translateMutation.reset();
		setFormOpen(true);
	};
	const closeForm = () => {
		setFormOpen(false);
		setSelectedId(null);
		createMutation.reset();
		updateMutation.reset();
		translateMutation.reset();
	};
	const submitForm = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSaving || !form.displayName || !form.slug) return;
		if (selectedId) {
			updateMutation.mutate();
		} else {
			createMutation.mutate();
		}
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

			<Dialog.Root
				open={formOpen}
				onOpenChange={(open) => {
					if (!open && !isSaving && !deleteTarget) closeForm();
				}}
				disablePointerDismissal={isSaving || !!deleteTarget}
			>
				<Dialog
					className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 sm:w-[36rem]"
					size="lg"
				>
					<form onSubmit={submitForm} className="flex min-h-0 flex-1 flex-col">
						<div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-6 py-5">
							<div className="min-w-0">
								<Dialog.Title className="text-lg font-semibold">
									{selected ? t`Edit byline` : t`New byline`}
								</Dialog.Title>
								<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
									{selected
										? t`Update the profile for ${selected.displayName}.`
										: t`Add a person or team to credit on your content.`}
								</Dialog.Description>
							</div>
							<Dialog.Close
								aria-label={t`Close`}
								render={(props) => (
									<Button
										{...props}
										type="button"
										variant="ghost"
										shape="square"
										icon={<X className="size-4" aria-hidden="true" />}
										aria-label={t`Close`}
										disabled={isSaving}
									/>
								)}
							/>
						</div>

						<div className="emdash-auto-scrollbar min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-6 py-6">
							<Input
								label={t`Display name`}
								value={form.displayName}
								onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
								required
							/>
							<Input
								label={t`Slug`}
								value={form.slug}
								onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
								required
							/>
							<Input
								label={t`Website URL`}
								value={form.websiteUrl}
								onChange={(e) => setForm((prev) => ({ ...prev, websiteUrl: e.target.value }))}
							/>
							<InputArea
								label={t`Bio`}
								value={form.bio}
								onChange={(e) => setForm((prev) => ({ ...prev, bio: e.target.value }))}
								rows={5}
							/>
							<BylineAvatarField
								value={form.avatarMediaId}
								onChange={(mediaId) => setForm((prev) => ({ ...prev, avatarMediaId: mediaId }))}
							/>
							<div className="space-y-4 border-t border-kumo-line pt-5">
								<div className="space-y-1">
									<h3 className="text-sm font-semibold">{t`Attribution`}</h3>
									<p className="text-sm text-kumo-subtle">
										{t`Link this byline to a user or mark it as a guest profile.`}
									</p>
								</div>
								<Select
									label={t`Linked user`}
									value={form.userId ?? ""}
									onValueChange={(value) => {
										const userId = (value as string) || null;
										setForm((prev) => ({
											...prev,
											userId,
											isGuest: userId ? false : prev.isGuest,
										}));
									}}
									items={{
										"": t`No linked user`,
										...Object.fromEntries(users.map((user) => [user.id, getUserLabel(user)])),
									}}
									className="w-full"
								/>
								<Switch
									label={t`Guest byline`}
									checked={form.isGuest}
									onCheckedChange={(checked) =>
										setForm((prev) => ({
											...prev,
											isGuest: checked,
											userId: checked ? null : prev.userId,
										}))
									}
								/>
							</div>

							{customFieldDefs.length > 0 && (
								<div className="space-y-4 border-t border-kumo-line pt-5">
									<h3 className="text-sm font-semibold">{t`Additional details`}</h3>
									{customFieldDefs.map((field) => (
										<CustomFieldInput
											key={field.id}
											field={field}
											value={form.customFields[field.slug]}
											onChange={(next) =>
												setForm((prev) => ({
													...prev,
													customFields: {
														...prev.customFields,
														[field.slug]: next,
													},
												}))
											}
										/>
									))}
								</div>
							)}
							{customFieldsError && (
								<div className="rounded-md border border-kumo-danger/40 bg-kumo-danger/5 p-3 text-sm">
									<p className="font-medium text-kumo-danger">{t`Couldn't load custom fields.`}</p>
									<p className="mt-1 text-xs text-kumo-subtle">
										{t`You can still edit the fixed fields above. Saving will not touch any stored custom-field values.`}
									</p>
								</div>
							)}

							{selected && isMultiLocale && i18n ? (
								<div className="border-t border-kumo-line pt-5">
									<TranslationsPanel
										locales={i18n.locales}
										defaultLocale={i18n.defaultLocale}
										currentLocale={selected.locale}
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
							) : null}
						</div>
						<DialogError message={getMutationError(mutationError)} className="mx-6 mt-3" />

						<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-kumo-line px-6 py-4">
							{selected && (
								<Button
									type="button"
									variant="secondary-destructive"
									onClick={() => setDeleteTarget(selected)}
									disabled={isSaving}
								>
									{t`Delete`}
								</Button>
							)}
							<div className="ms-auto flex items-center gap-2">
								<Button type="button" variant="secondary" onClick={closeForm} disabled={isSaving}>
									{t`Cancel`}
								</Button>
								<Button
									type="submit"
									variant="primary"
									disabled={!form.displayName || !form.slug || isSaving}
								>
									{isSaving ? t`Saving...` : selected ? t`Save` : t`Create`}
								</Button>
							</div>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

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

/**
 * Renders a single registered byline custom field as the appropriate
 * Kumo input for its type (Phase 6 of #1174).
 *
 * Five v1 type cases mirror `BylineFieldType` and the inputs that
 * `BylineFieldEditor` allows admins to register. Empty string inputs
 * coerce to `null` on save so the repo's "null clears the row"
 * storage semantic engages — server-side `BylineRepository.update`
 * deletes the value row rather than storing an empty-string JSON.
 *
 * `field.required` adds a `*` after the label as a visual hint; the
 * server is authoritative on validation (Phase 6 ACs don't include a
 * client-side required check — the registry's `required` flag is
 * descriptive rather than enforced in the write path today).
 */
function CustomFieldInput({
	field,
	value,
	onChange,
}: {
	field: BylineFieldDefinition;
	value: unknown;
	onChange: (next: unknown) => void;
}) {
	const { t } = useLingui();
	const label = field.required ? `${field.label} *` : field.label;
	const stringValue = typeof value === "string" ? value : "";

	switch (field.type) {
		case "string":
			return (
				<Input
					label={label}
					value={stringValue}
					onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				/>
			);
		case "text":
			return (
				<InputArea
					label={label}
					value={stringValue}
					onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
					rows={3}
				/>
			);
		case "url":
			return (
				<Input
					type="url"
					label={label}
					value={stringValue}
					onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				/>
			);
		case "boolean":
			// Booleans are always definite once the field is registered —
			// `null` would mean "no row stored", which conceptually maps
			// to `false` for a yes/no toggle. The Switch sends a real
			// boolean and the storage path persists it verbatim.
			return (
				<Switch
					label={label}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);
		case "select": {
			const options = field.validation?.options ?? [];
			// Null-prototype object so options that collide with
			// `Object.prototype` keys (`__proto__`, `toString`) survive.
			const items: Record<string, string> = Object.create(null);
			items[""] = t`-- Select --`;
			for (const opt of options) items[opt] = opt;
			return (
				<Select
					label={label}
					value={stringValue}
					onValueChange={(v) => onChange(!v ? null : v)}
					items={items}
					className="w-full"
				/>
			);
		}
	}
}
