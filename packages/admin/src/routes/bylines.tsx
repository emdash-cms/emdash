import { Button, Input, InputArea, Loader, Select, Switch } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DialogError, getMutationError } from "../components/DialogError.js";
import { LocaleSwitcher, useI18nConfig } from "../components/LocaleSwitcher.js";
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

interface BylineFormState {
	slug: string;
	displayName: string;
	bio: string;
	websiteUrl: string;
	userId: string | null;
	isGuest: boolean;
	/**
	 * Custom-field values keyed by field slug (Phase 6 of #1174). Always
	 * a defined object — `{}` when no fields are registered or the byline
	 * has no stored values — so callers can spread it into update bodies
	 * unconditionally.
	 */
	customFields: Record<string, unknown>;
}

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
		customFields: byline.customFields ?? {},
	};
}

function getUserLabel(user: UserListItem): string {
	if (user.name) return `${user.name} (${user.email})`;
	return user.email;
}

export function BylinesPage() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { locale: routeLocale } = useSearch({ from: "/_admin/bylines" });
	const [search, setSearch] = React.useState("");
	const [guestFilter, setGuestFilter] = React.useState<"all" | "guest" | "linked">("all");
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
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
		queryKey: ["bylines", search, guestFilter, activeLocale ?? null],
		queryFn: () =>
			fetchBylines({
				search: search || undefined,
				isGuest: guestFilter === "all" ? undefined : guestFilter === "guest",
				locale: activeLocale,
				limit: 50,
			}),
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
			if (!loadMoreSnapshotMatches(snapshot, { search, guestFilter, locale: activeLocale })) {
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
		mutationFn: () =>
			createByline({
				slug: form.slug,
				displayName: form.displayName,
				bio: form.bio || null,
				websiteUrl: form.websiteUrl || null,
				userId: form.userId,
				isGuest: form.isGuest,
				locale: activeLocale,
			}),
		onSuccess: (created) => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			setSelectedId(created.id);
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
		},
	});

	const deleteMutation = useMutation({
		mutationFn: () => {
			if (!selectedId) throw new Error("No byline selected");
			return deleteByline(selectedId);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			setSelectedId(null);
			setShowDeleteConfirm(false);
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

	if (isLoading) {
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
	const mutationError =
		createMutation.error || updateMutation.error || deleteMutation.error || translateMutation.error;

	return (
		<div className="space-y-4">
			{isMultiLocale && i18n && activeLocale ? (
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-semibold">{t`Bylines`}</h1>
					</div>
					<LocaleSwitcher
						locales={i18n.locales}
						defaultLocale={i18n.defaultLocale}
						value={activeLocale}
						onChange={handleLocaleChange}
					/>
				</div>
			) : null}

			<div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
				<div className="rounded-lg border p-4">
					<div className="mb-4 space-y-2">
						<Input
							placeholder={t`Search bylines`}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
						<div className="flex items-center gap-2">
							<div className="flex-1">
								<Select
									aria-label={t`Filter byline type`}
									value={guestFilter}
									onValueChange={(v) => setGuestFilter((v as "all" | "guest" | "linked") ?? "all")}
									items={{
										all: t`All bylines`,
										guest: t`Guest only`,
										linked: t`Linked only`,
									}}
									className="w-full"
								/>
							</div>
							<Button
								variant="secondary"
								onClick={() => {
									setSelectedId(null);
									setForm(toFormState(null));
								}}
							>
								{t`New`}
							</Button>
						</div>
					</div>

					<div className="space-y-2 max-h-[70vh] overflow-auto">
						{items.map((item) => {
							const active = item.id === selectedId;
							return (
								<button
									key={item.id}
									type="button"
									onClick={() => setSelectedId(item.id)}
									className={`w-full rounded border p-3 text-start ${
										active ? "border-kumo-brand bg-kumo-brand/10" : "border-kumo-line"
									}`}
								>
									<p className="font-medium">{item.displayName}</p>
									<p className="text-xs text-kumo-subtle">
										{item.slug}
										{item.isGuest ? t` - Guest` : item.userId ? t` - Linked` : ""}
									</p>
								</button>
							);
						})}
						{items.length === 0 && (
							<p className="text-sm text-kumo-subtle">{t`No bylines found`}</p>
						)}
						{nextCursor && (
							<Button
								variant="secondary"
								className="w-full mt-2"
								onClick={() =>
									loadMoreMutation.mutate({
										search,
										guestFilter,
										locale: activeLocale,
										cursor: nextCursor,
									})
								}
								disabled={loadMoreMutation.isPending}
							>
								{loadMoreMutation.isPending ? t`Loading...` : t`Load more`}
							</Button>
						)}
					</div>
				</div>

				<div className="rounded-lg border p-6 space-y-6">
					<h2 className="text-lg font-semibold">
						{selected ? t`Edit ${selected.displayName}` : t`Create byline`}
					</h2>

					<div className="space-y-4">
						<Input
							label={t`Display name`}
							value={form.displayName}
							onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
						/>
						<Input
							label={t`Slug`}
							value={form.slug}
							onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
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
						<Select
							label={t`Linked user`}
							value={form.userId ?? ""}
							onValueChange={(v) => {
								const val = (v as string) || null;
								setForm((prev) => ({
									...prev,
									userId: val,
									isGuest: val ? false : prev.isGuest,
								}));
							}}
							items={{
								"": t`No linked user`,
								...Object.fromEntries(users.map((u) => [u.id, getUserLabel(u)])),
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

						{/*
						 * Phase 6 of #1174 — render registered custom-field
						 * inputs. Edit-mode only: the server-side
						 * `bylineCreateBody` zod schema does not accept
						 * `customFields`, so showing inputs during the
						 * create flow would set expectations the API can't
						 * meet. The user creates the bare byline first; the
						 * page re-renders in edit mode with `selected`
						 * truthy, and the inputs appear.
						 *
						 * TODO: when a third extensible system table needs
						 * custom fields, file a refactor Discussion to
						 * extract <FieldRenderer> for reuse. The switch
						 * below is intentionally inlined for now — pulling
						 * it into a shared component for one consumer
						 * (this) would just move the complexity.
						 */}
						{selected && customFieldDefs.length > 0 && (
							<div className="space-y-4 pt-4 border-t border-kumo-line">
								<h3 className="text-sm font-medium text-kumo-subtle">{t`Custom fields`}</h3>
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
						{selected && customFieldsError && (
							<div className="rounded-md border border-kumo-danger/40 bg-kumo-danger/5 p-3 text-sm">
								<p className="font-medium text-kumo-danger">{t`Couldn't load custom fields.`}</p>
								<p className="text-xs text-kumo-subtle mt-1">
									{t`You can still edit the fixed fields above. Saving will not touch any stored custom-field values.`}
								</p>
							</div>
						)}

						<DialogError message={getMutationError(mutationError)} />

						<div className="flex gap-2 pt-2">
							<Button
								onClick={() => {
									if (selected) {
										updateMutation.mutate();
									} else {
										createMutation.mutate();
									}
								}}
								disabled={!form.displayName || !form.slug || isSaving}
							>
								{isSaving ? t`Saving...` : selected ? t`Save` : t`Create`}
							</Button>

							{selected && (
								<Button
									variant="destructive"
									onClick={() => setShowDeleteConfirm(true)}
									disabled={deleteMutation.isPending}
								>
									{t`Delete`}
								</Button>
							)}
						</div>
					</div>

					{selected && isMultiLocale && i18n ? (
						<div className="border-t pt-6">
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
			</div>

			<ConfirmDialog
				open={showDeleteConfirm}
				onClose={() => {
					setShowDeleteConfirm(false);
					deleteMutation.reset();
				}}
				title={t`Delete Byline?`}
				description={t`This removes the byline profile. Content byline links are removed and lead pointers are cleared.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteMutation.mutate()}
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
			// The empty-string entry serves as a "clear value" affordance;
			// it produces `null` on change, which deletes the stored row
			// per the repo's storage contract. Server-side `required`
			// enforcement (if added later) would reject the resulting
			// write rather than this dropdown disabling the entry.
			const items: Record<string, string> = { "": t`-- Select --` };
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
