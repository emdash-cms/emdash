import {
	Badge,
	Button,
	Dialog,
	DropdownMenu,
	Input,
	Label,
	Select,
	Switch,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	ArrowsLeftRight,
	FileX,
	Trash,
	Pencil,
	WarningCircle,
	X,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import {
	createRedirect,
	deleteRedirect,
	fetch404Summary,
	fetchRedirects,
	updateRedirect,
} from "../lib/api/redirects.js";
import type {
	CreateRedirectInput,
	NotFoundSummary,
	Redirect,
	UpdateRedirectInput,
} from "../lib/api/redirects.js";
import { cn, formatDate } from "../lib/utils.js";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { ArrowNext } from "./ArrowIcons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import {
	DataTable,
	RowActionsMenu,
	RowMeta,
	RowTitleButton,
	secondaryColumn,
	tertiaryColumn,
} from "./DataTable.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { PageHeader } from "./PageHeader.js";
import { TableToolbarSearch } from "./TableToolbar.js";

// ---------------------------------------------------------------------------
// Redirect form dialog (create + edit)
// ---------------------------------------------------------------------------

function RedirectFormDialog({
	open,
	onClose,
	redirect,
	defaultSource,
}: {
	open: boolean;
	onClose: () => void;
	/** Pass for edit mode */
	redirect?: Redirect;
	/** Pre-fill source for create mode (e.g. from 404 list) */
	defaultSource?: string;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const isEdit = !!redirect;

	const [source, setSource] = useState(redirect?.source ?? defaultSource ?? "");
	const [destination, setDestination] = useState(redirect?.destination ?? "");
	const [type, setType] = useState(String(redirect?.type ?? 301));
	const [enabled, setEnabled] = useState(redirect?.enabled ?? true);
	const [groupName, setGroupName] = useState(redirect?.groupName ?? "");

	// Terminal statuses (410 Gone / 451) serve a status directly — no destination.
	const isTerminal = type === "410" || type === "451";

	const createMutation = useMutation({
		mutationFn: (input: CreateRedirectInput) => createRedirect(input),
		onSuccess: () => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
			onClose();
		},
	});

	const updateMutation = useMutation({
		mutationFn: (input: UpdateRedirectInput) => updateRedirect(redirect!.id, input),
		onSuccess: () => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
			onClose();
		},
	});

	const mutation = isEdit ? updateMutation : createMutation;

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const input = {
			source: source.trim(),
			destination: isTerminal ? "" : destination.trim(),
			type: Number(type),
			enabled,
			groupName: groupName.trim() || null,
		};

		if (isEdit) {
			updateMutation.mutate(input);
		} else {
			createMutation.mutate(input);
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
			<Dialog className="p-6" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<div>
						<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
							{isEdit ? t`Edit Redirect` : t`New Redirect`}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mt-1">
							{isEdit
								? t`Update this redirect rule.`
								: t`Use [param] or [...rest] in paths for pattern matching.`}
						</p>
					</div>
					<Dialog.Close
						aria-label={t`Close`}
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label={t`Close`}
								className="absolute end-4 top-4"
							>
								<X className="h-4 w-4" />
							</Button>
						)}
					/>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<Input
						dir="ltr"
						label={t`Source path`}
						placeholder={t`/old-page or /blog/[slug]`}
						value={source}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSource(e.target.value)}
						required
					/>

					{!isTerminal && (
						<Input
							dir="ltr"
							label={t`Destination path`}
							placeholder={t`/new-page or /articles/[slug]`}
							value={destination}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDestination(e.target.value)}
							required
						/>
					)}

					<div className="grid grid-cols-2 gap-4">
						<div>
							<Select
								label={t`Status code`}
								value={type}
								onValueChange={(v) => setType(v ?? "301")}
								items={{
									"301": t`301 Permanent`,
									"302": t`302 Temporary`,
									"307": t`307 Temporary (Strict)`,
									"308": t`308 Permanent (Strict)`,
									"410": t`410 Content Deleted (Gone)`,
									"451": t`451 Unavailable for legal reasons`,
								}}
							/>
						</div>

						<Input
							label={t`Group (optional)`}
							placeholder={t`e.g. import, blog`}
							value={groupName}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGroupName(e.target.value)}
						/>
					</div>

					<div className="flex items-center gap-2">
						<Switch checked={enabled} onCheckedChange={setEnabled} id="redirect-enabled" />
						<Label htmlFor="redirect-enabled">{t`Enabled`}</Label>
					</div>

					<DialogError message={getMutationError(mutation.error)} />

					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							{t`Cancel`}
						</Button>
						<Button type="submit" disabled={mutation.isPending}>
							{mutation.isPending
								? isEdit
									? t`Saving...`
									: t`Creating...`
								: isEdit
									? t`Save`
									: t`Create`}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

// ---------------------------------------------------------------------------
// 404 Summary panel
// ---------------------------------------------------------------------------

function NotFoundPanel({
	items,
	onCreateRedirect,
	onMarkGone,
}: {
	items: NotFoundSummary[];
	onCreateRedirect: (path: string) => void;
	onMarkGone: (path: string) => void;
}) {
	const { t, i18n } = useLingui();
	const goneDescriptionId = useId();

	if (items.length === 0) {
		return (
			<p className="text-sm text-kumo-subtle py-4 text-center">{t`No 404 errors recorded yet.`}</p>
		);
	}

	const goneDescription = t`Mark as Gone (410) — tells search engines it was permanently deleted`;

	return (
		<>
			<span id={goneDescriptionId} hidden>
				{goneDescription}
			</span>
			<DataTable>
				<thead>
					<tr>
						<th scope="col">{t`Path`}</th>
						<th scope="col" className="text-end" {...secondaryColumn}>
							{t`Hits`}
						</th>
						<th scope="col" {...tertiaryColumn}>
							{t`Last seen`}
						</th>
						<th scope="col" className="w-0">
							<span className="sr-only">{t`Actions`}</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{items.map((item) => {
						const date = new Date(item.lastSeen);
						const lastSeen = Number.isNaN(date.getTime()) ? (
							item.lastSeen
						) : (
							<bdi>{formatDate(date, i18n.locale)}</bdi>
						);
						return (
							<tr key={item.path}>
								<td className="text-sm">
									<code dir="ltr" className="wrap-anywhere">
										{item.path}
									</code>
									<RowMeta>
										<span className="tabular-nums">
											{plural(item.count, { one: "# hit", other: "# hits" })}
										</span>
									</RowMeta>
									<RowMeta priority="tertiary">{lastSeen}</RowMeta>
								</td>
								<td className="text-end text-sm tabular-nums" {...secondaryColumn}>
									{i18n.number(item.count)}
								</td>
								<td className="text-sm whitespace-nowrap text-kumo-subtle" {...tertiaryColumn}>
									{lastSeen}
								</td>
								<td>
									<div className="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="sm"
											shape="square"
											title={t`Create redirect for this path`}
											aria-label={t`Create redirect for ${item.path}`}
											onClick={() => onCreateRedirect(item.path)}
										>
											<ArrowsLeftRight size={16} aria-hidden="true" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											title={goneDescription}
											aria-label={t`Mark ${item.path} as Gone (410)`}
											aria-describedby={goneDescriptionId}
											onClick={() => onMarkGone(item.path)}
										>
											410
										</Button>
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</DataTable>
		</>
	);
}

// ---------------------------------------------------------------------------
// Redirect row
// ---------------------------------------------------------------------------

function RedirectRow({
	redirect,
	inLoop,
	onToggle,
	onEdit,
	onDelete,
}: {
	redirect: Redirect;
	inLoop: boolean;
	onToggle: (enabled: boolean) => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const { t, i18n } = useLingui();
	const code = <Badge variant="secondary">{redirect.type}</Badge>;

	return (
		// Fading the row would also fade its cells' background, letting the darker tray show through.
		<tr className={cn(!redirect.enabled && "[&>td>*]:opacity-50")}>
			<td className="text-sm">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<RowTitleButton aria-label={t`Edit redirect ${redirect.source}`} onClick={onEdit}>
						<code dir="ltr" className="wrap-anywhere">
							{redirect.source}
						</code>
					</RowTitleButton>
					{inLoop && (
						<span title={t`Part of a redirect loop`} className="inline-flex">
							<WarningCircle
								size={16}
								weight="fill"
								className="text-kumo-warning"
								role="img"
								aria-label={t`Part of a redirect loop`}
							/>
						</span>
					)}
					{redirect.auto && <Badge variant="outline">{t`auto`}</Badge>}
				</div>
				{redirect.destination && (
					<div className="mt-1 flex gap-1.5 text-xs text-kumo-subtle">
						<ArrowNext className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
						{/* As a flex item, the LTR path would align its wrapped lines left on RTL pages. */}
						<span className="min-w-0">
							<code dir="ltr" className="wrap-anywhere">
								{redirect.destination}
							</code>
						</span>
					</div>
				)}
				<RowMeta priority="tertiary">
					{code}
					<span className="tabular-nums">
						{plural(redirect.hits, { one: "# hit", other: "# hits" })}
					</span>
				</RowMeta>
			</td>
			<td {...tertiaryColumn}>{code}</td>
			<td className="text-end text-sm tabular-nums text-kumo-subtle" {...tertiaryColumn}>
				<span>{i18n.number(redirect.hits)}</span>
			</td>
			<td>
				<Switch
					checked={redirect.enabled}
					onCheckedChange={onToggle}
					aria-label={redirect.enabled ? t`Disable redirect` : t`Enable redirect`}
				/>
			</td>
			<td className="text-end">
				<RowActionsMenu label={t`Actions for redirect ${redirect.source}`}>
					<DropdownMenu.Item
						icon={<Pencil className="me-2 size-4" aria-hidden="true" />}
						onClick={onEdit}
					>
						{t`Edit`}
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						variant="danger"
						icon={<Trash className="me-2 size-4" aria-hidden="true" />}
						aria-label={t`Delete redirect ${redirect.source}`}
						onClick={onDelete}
					>
						{t`Delete`}
					</DropdownMenu.Item>
				</RowActionsMenu>
			</td>
		</tr>
	);
}

// ---------------------------------------------------------------------------
// Main Redirects page
// ---------------------------------------------------------------------------

type TabKey = "redirects" | "404s";

export function Redirects() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<TabKey>("redirects");
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [filterEnabled, setFilterEnabled] = useState<string>("all");
	const [filterAuto, setFilterAuto] = useState<string>("all");
	const [filterGroup, setFilterGroup] = useState("");
	const [debouncedGroup, setDebouncedGroup] = useState("");

	// Debounce search input
	useEffect(() => {
		const timer = setTimeout(setDebouncedSearch, 300, search);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		const timer = setTimeout(setDebouncedGroup, 300, filterGroup);
		return () => clearTimeout(timer);
	}, [filterGroup]);

	// Dialog state
	const [showCreate, setShowCreate] = useState(false);
	const [editRedirect, setEditRedirect] = useState<Redirect | null>(null);
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const [prefillSource, setPrefillSource] = useState("");

	// Queries
	const enabledFilter = filterEnabled === "all" ? undefined : filterEnabled === "true";
	const autoFilter = filterAuto === "all" ? undefined : filterAuto === "true";
	const groupFilter = debouncedGroup.trim() || undefined;
	const hasFilters =
		!!debouncedSearch || enabledFilter !== undefined || autoFilter !== undefined || !!groupFilter;

	const redirectsQuery = useInfiniteQuery({
		queryKey: ["redirects", debouncedSearch, enabledFilter, autoFilter, groupFilter],
		queryFn: ({ pageParam }) =>
			fetchRedirects({
				search: debouncedSearch || undefined,
				group: groupFilter,
				enabled: enabledFilter,
				auto: autoFilter,
				cursor: pageParam,
				limit: 100,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});

	const notFoundQuery = useQuery({
		queryKey: ["redirects", "404-summary"],
		queryFn: () => fetch404Summary(50),
		enabled: tab === "404s",
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteRedirect(id),
		onSuccess: () => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
			setDeleteId(null);
		},
	});

	// Toggle enabled mutation
	const toggleMutation = useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			updateRedirect(id, { enabled }),
		onSuccess: () => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
		},
		onError: () => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
		},
	});

	// One-click "Gone": create a 410 rule (no destination) for a 404 path.
	const markGoneMutation = useMutation({
		mutationFn: (path: string) =>
			createRedirect({ source: path, destination: "", type: 410, enabled: true }),
		onSuccess: () => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
		},
	});

	function handleCreateFrom404(path: string) {
		setPrefillSource(path);
		setShowCreate(true);
		setTab("redirects");
	}

	const redirects = redirectsQuery.data?.pages.flatMap((page) => page.items) ?? [];
	const loopRedirectIds = new Set(
		redirectsQuery.data?.pages.flatMap((page) => page.loopRedirectIds ?? []) ?? [],
	);
	const searchPlaceholder = t`Search source or destination...`;

	return (
		<div className="space-y-6">
			<PageHeader
				title={t`Redirects`}
				description={t`Manage URL redirects and view 404 errors.`}
				value={tab}
				onValueChange={(value) => {
					if (value === "redirects" || value === "404s") setTab(value);
				}}
				actions={
					<Button variant="primary" icon={<Plus />} onClick={() => setShowCreate(true)}>
						{t`New Redirect`}
					</Button>
				}
				tools={
					tab === "redirects" ? (
						<>
							<TableToolbarSearch
								size="base"
								placeholder={searchPlaceholder}
								aria-label={searchPlaceholder}
								value={search}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
							/>
							<Input
								aria-label={t`Filter by group`}
								placeholder={t`Exact group name...`}
								value={filterGroup}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setFilterGroup(e.target.value)
								}
							/>
							<div className="grid grid-cols-2 gap-2 sm:flex">
								<Select
									className="w-full sm:w-auto"
									value={filterEnabled}
									onValueChange={(v) => setFilterEnabled(v ?? "all")}
									items={{ all: t`All statuses`, true: t`Enabled`, false: t`Disabled` }}
									aria-label={t`Filter by status`}
								/>
								<Select
									className="w-full sm:w-auto"
									value={filterAuto}
									onValueChange={(v) => setFilterAuto(v ?? "all")}
									items={{ all: t`All types`, false: t`Manual`, true: t`Auto (slug change)` }}
									aria-label={t`Filter by type`}
								/>
							</div>
						</>
					) : undefined
				}
				tabs={[
					{
						value: "redirects",
						className: "flex-1 justify-center text-sm sm:flex-none",
						label: (
							<span className="flex items-center gap-1.5">
								<ArrowsLeftRight
									className="size-4 shrink-0"
									weight={tab === "redirects" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`Redirects`}
								{redirectsQuery.data && (
									<Badge variant="secondary">
										{redirects.length}
										{redirectsQuery.hasNextPage ? "+" : ""}
									</Badge>
								)}
							</span>
						),
					},
					{
						value: "404s",
						className: "flex-1 justify-center text-sm sm:flex-none",
						label: (
							<span className="flex items-center gap-1.5">
								<FileX
									className="size-4 shrink-0"
									weight={tab === "404s" ? "fill" : "regular"}
									aria-hidden="true"
								/>
								{t`404 Errors`}
							</span>
						),
					},
				]}
			/>

			{/* Tab content */}
			{tab === "redirects" && (
				<>
					{/* Loop warning banner */}
					{loopRedirectIds.size > 0 && (
						<div
							role="alert"
							className="flex items-start gap-3 rounded-lg border border-kumo-warning/50 bg-kumo-warning-tint p-4"
						>
							<WarningCircle
								size={20}
								className="mt-0.5 shrink-0 text-kumo-warning"
								weight="fill"
								aria-hidden="true"
							/>
							<div>
								<p className="text-sm font-medium text-kumo-warning">{t`Redirect loop detected`}</p>
								<p className="mt-1 text-sm text-kumo-subtle">
									{plural(loopRedirectIds.size, {
										one: "# redirect is part of a loop.",
										other: "# redirects are part of a loop.",
									})}{" "}
									{t`Visitors hitting these paths will see an error.`}
								</p>
							</div>
						</div>
					)}

					{/* Redirect list */}
					{redirectsQuery.isLoading ? (
						<div className="py-12 text-center text-kumo-subtle">{t`Loading redirects...`}</div>
					) : redirects.length === 0 ? (
						<div className="py-10 text-center text-kumo-subtle">
							<ADMIN_NAV_ICONS.redirects size={40} className="mx-auto mb-3 opacity-30" />
							<p className="text-base font-medium">
								{hasFilters ? t`No redirects match these filters` : t`No redirects yet`}
							</p>
							<p className="text-sm mt-1">
								{hasFilters
									? t`Try changing or clearing your filters.`
									: t`Create redirect rules to manage URL changes.`}
							</p>
						</div>
					) : (
						<>
							<DataTable>
								<thead>
									<tr>
										<th scope="col">
											<span className="flex flex-wrap items-center gap-x-1.5">
												{t`Source`}
												<span className="flex items-center gap-1.5">
													<ArrowNext className="size-3.5" aria-hidden="true" />
													{t`Destination`}
												</span>
											</span>
										</th>
										<th scope="col" {...tertiaryColumn}>
											{t`Code`}
										</th>
										<th scope="col" className="text-end" {...tertiaryColumn}>
											{t`Hits`}
										</th>
										<th scope="col">{t`Status`}</th>
										<th scope="col" className="w-0">
											<span className="sr-only">{t`Actions`}</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{redirects.map((redirect) => (
										<RedirectRow
											key={redirect.id}
											redirect={redirect}
											inLoop={loopRedirectIds.has(redirect.id)}
											onToggle={(enabled) => toggleMutation.mutate({ id: redirect.id, enabled })}
											onEdit={() => setEditRedirect(redirect)}
											onDelete={() => setDeleteId(redirect.id)}
										/>
									))}
								</tbody>
							</DataTable>
							{redirectsQuery.hasNextPage && (
								<div className="flex justify-center">
									<Button
										variant="outline"
										onClick={() => void redirectsQuery.fetchNextPage()}
										disabled={redirectsQuery.isFetchingNextPage}
									>
										{redirectsQuery.isFetchingNextPage ? t`Loading...` : t`Load more`}
									</Button>
								</div>
							)}
						</>
					)}
				</>
			)}

			{tab === "404s" && (
				<NotFoundPanel
					items={notFoundQuery.data ?? []}
					onCreateRedirect={handleCreateFrom404}
					onMarkGone={(path) => markGoneMutation.mutate(path)}
				/>
			)}

			{/* Create dialog */}
			{showCreate && (
				<RedirectFormDialog
					open
					onClose={() => {
						setShowCreate(false);
						setPrefillSource("");
					}}
					defaultSource={prefillSource || undefined}
				/>
			)}

			{/* Edit dialog */}
			{editRedirect && (
				<RedirectFormDialog open onClose={() => setEditRedirect(null)} redirect={editRedirect} />
			)}

			{/* Delete confirmation */}
			<ConfirmDialog
				open={!!deleteId}
				onClose={() => {
					setDeleteId(null);
					deleteMutation.reset();
				}}
				title={t`Delete Redirect?`}
				description={t`This redirect rule will be permanently removed.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteId && deleteMutation.mutate(deleteId)}
			/>
		</div>
	);
}
