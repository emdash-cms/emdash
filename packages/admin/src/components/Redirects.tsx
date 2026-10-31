import {
	Badge,
	Button,
	Input,
	LayerDialog,
	Select,
	Switch,
	useKumoToastManager,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	ArrowsLeftRight,
	FileX,
	Trash,
	PencilSimple,
	WarningCircle,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import { ApiResponseError } from "../lib/api/client.js";
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
import {
	guardUnsavedInput,
	revealErrors,
	useSingleFlight,
	useTakenValue,
} from "../lib/dialog-form.js";
import { cn, formatDate } from "../lib/utils.js";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { ArrowNext } from "./ArrowIcons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { PageHeader } from "./PageHeader.js";
import { TableToolbarSearch } from "./TableToolbar.js";

// ---------------------------------------------------------------------------
// Redirect form dialog (create + edit)
// ---------------------------------------------------------------------------

type RedirectField = "source" | "destination";

/** Why the server would refuse a path that isn't empty. */
function pathProblem(path: string): MessageDescriptor | undefined {
	if (!path.startsWith("/") || path.startsWith("//")) {
		return msg`Enter a path that starts with a single /.`;
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		return msg`Fix the percent-encoding in the path.`;
	}
	if (decoded.split("/").includes("..")) return msg`Remove the .. segments from the path.`;
	return undefined;
}

function redirectProblems(
	source: string,
	destination: string,
	terminal: boolean,
): Partial<Record<RedirectField, MessageDescriptor>> {
	const problems: Partial<Record<RedirectField, MessageDescriptor>> = {};
	const sourceProblem = source ? pathProblem(source) : msg`Enter a source path.`;
	if (sourceProblem) problems.source = sourceProblem;
	if (terminal) return problems;
	const destinationProblem = destination
		? pathProblem(destination)
		: msg`Enter a destination path.`;
	if (destinationProblem) {
		problems.destination = destinationProblem;
	} else if (destination === source) {
		problems.destination = msg`Enter a destination different from the source.`;
	}
	return problems;
}

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
	const formId = useId();
	const formRef = useRef<HTMLFormElement>(null);

	const [initial] = useState(() => ({
		source: redirect?.source ?? defaultSource ?? "",
		destination: redirect?.destination ?? "",
		type: String(redirect?.type ?? 301),
		enabled: redirect?.enabled ?? true,
		groupName: redirect?.groupName ?? "",
	}));
	const [source, setSource] = useState(initial.source);
	const [destination, setDestination] = useState(initial.destination);
	const [type, setType] = useState(initial.type);
	const [enabled, setEnabled] = useState(initial.enabled);
	const [groupName, setGroupName] = useState(initial.groupName);
	const [submitted, setSubmitted] = useState(false);

	// Terminal statuses (410 Gone / 451) serve a status directly — no destination.
	const isTerminal = type === "410" || type === "451";
	const unsaved =
		source !== initial.source ||
		destination !== initial.destination ||
		type !== initial.type ||
		enabled !== initial.enabled ||
		groupName !== initial.groupName;

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

	const trimmedSource = source.trim();
	const trimmedDestination = destination.trim();
	const takenSource = useTakenValue(trimmedSource);
	const problems = redirectProblems(trimmedSource, trimmedDestination, isTerminal);
	if (takenSource.isTaken) {
		problems.source = msg`Another redirect already uses this source path. Enter a different one.`;
	}
	const errors: Partial<Record<RedirectField, string>> = {};
	if (submitted) {
		for (const [field, message] of Object.entries(problems)) {
			errors[field as RedirectField] = t(message);
		}
	}
	const saveError = mutation.error;
	const bannerError = getMutationError(takenSource.unlessTaken(saveError));

	const showErrors = (update?: () => void) => {
		revealErrors(formRef.current, () => {
			setSubmitted(true);
			update?.();
		});
	};

	const save = useSingleFlight((input: CreateRedirectInput) => {
		const onError = (error: Error) => {
			if (
				error instanceof ApiResponseError &&
				error.code === "CONFLICT" &&
				takenSource.stillHolds(input.source)
			) {
				showErrors(() => takenSource.take(input.source, error));
			}
		};
		return isEdit
			? updateMutation.mutateAsync(input, { onError })
			: createMutation.mutateAsync(input, { onError });
	});

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (mutation.isPending) return;
		if (Object.keys(problems).length > 0) {
			showErrors();
			return;
		}
		save({
			source: trimmedSource,
			destination: isTerminal ? "" : trimmedDestination,
			type: Number(type),
			enabled,
			groupName: groupName.trim() || null,
		});
	}

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(unsaved, (nextOpen) => {
				if (!nextOpen && !mutation.isPending) onClose();
			})}
			dismissDisabled={mutation.isPending}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{isEdit ? t`Edit Redirect` : t`New Redirect`}</LayerDialog.Title>
				<LayerDialog.Description>
					{isEdit
						? t`Update this redirect rule.`
						: t`Use [param] or [...rest] in paths for pattern matching.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<form ref={formRef} id={formId} noValidate onSubmit={handleSubmit} className="grid gap-5">
						<Input
							dir="ltr"
							label={t`Source path`}
							placeholder={t`/old-page or /blog/[slug]`}
							value={source}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSource(e.target.value)}
							required
							error={errors.source}
							aria-invalid={errors.source ? true : undefined}
						/>

						{!isTerminal && (
							<Input
								dir="ltr"
								label={t`Destination path`}
								placeholder={t`/new-page or /articles/[slug]`}
								value={destination}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setDestination(e.target.value)
								}
								required
								error={errors.destination}
								aria-invalid={errors.destination ? true : undefined}
							/>
						)}

						<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
							<Select
								label={t`Status code`}
								className="w-full"
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

							<Input
								label={t`Group (optional)`}
								placeholder={t`e.g. import, blog`}
								value={groupName}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGroupName(e.target.value)}
							/>
						</div>

						<Switch label={t`Enabled`} checked={enabled} onCheckedChange={setEnabled} />

						<DialogError message={bannerError} />
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={mutation.isPending}>
						{mutation.isPending
							? isEdit
								? t`Saving...`
								: t`Creating...`
							: isEdit
								? t`Save`
								: t`Create`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
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

	if (items.length === 0) {
		return (
			<p className="text-sm text-kumo-subtle py-4 text-center">{t`No 404 errors recorded yet.`}</p>
		);
	}

	return (
		<div className="border rounded-lg">
			<div className="flex items-center gap-4 py-2 px-4 border-b bg-kumo-tint/50 text-sm font-medium text-kumo-subtle">
				<div className="flex-1">{t`Path`}</div>
				<div className="w-16 text-end">{t`Hits`}</div>
				<div className="w-32">{t`Last seen`}</div>
				<div className="w-20" />
			</div>
			{items.map((item) => (
				<div
					key={item.path}
					className="flex items-center gap-4 py-2 px-4 border-b last:border-0 text-sm"
				>
					<div className="flex-1 font-mono text-xs truncate">
						<bdi dir="ltr">{item.path}</bdi>
					</div>
					<div className="w-16 text-end tabular-nums">{item.count}</div>
					<div className="w-32 text-kumo-subtle text-xs">
						{(() => {
							const d = new Date(item.lastSeen);
							return Number.isNaN(d.getTime()) ? (
								item.lastSeen
							) : (
								<bdi>{formatDate(d, i18n.locale)}</bdi>
							);
						})()}
					</div>
					<div className="w-20 flex items-center justify-end gap-3">
						<button
							onClick={() => onCreateRedirect(item.path)}
							className="text-kumo-subtle hover:text-kumo-default"
							title={t`Create redirect for this path`}
							aria-label={t`Create redirect for ${item.path}`}
						>
							<ArrowsLeftRight size={14} />
						</button>
						<button
							onClick={() => onMarkGone(item.path)}
							className="text-kumo-subtle hover:text-kumo-danger text-xs font-semibold tabular-nums"
							title={t`Mark as Gone (410) — tells search engines it was permanently deleted`}
							aria-label={t`Mark ${item.path} as Gone (410)`}
						>
							410
						</button>
					</div>
				</div>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main Redirects page
// ---------------------------------------------------------------------------

type TabKey = "redirects" | "404s";

interface RedirectFormTarget {
	/** Counts openings, so each one starts a new form. */
	visit: number;
	open: boolean;
	redirect?: Redirect;
	defaultSource?: string;
}

export function Redirects() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
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

	// Dialog state. The form keeps what it shows while it closes.
	const [form, setForm] = useState<RedirectFormTarget>({ visit: 0, open: false });
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const openForm = (target: Pick<RedirectFormTarget, "redirect" | "defaultSource"> = {}) =>
		setForm((current) => ({ ...target, visit: current.visit + 1, open: true }));

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

	// Delete mutation. A redirect that is already gone counts as deleted.
	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			try {
				await deleteRedirect(id);
				return true;
			} catch (error) {
				if (error instanceof ApiResponseError && error.code === "NOT_FOUND") return false;
				throw error;
			}
		},
		onSuccess: (deleted) => {
			void queryClient.resetQueries({ queryKey: ["redirects"] });
			setDeleteId(null);
			if (!deleted) {
				toastManager.add({ title: t`This redirect was already deleted.`, timeout: 3000 });
			}
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
		openForm({ defaultSource: path });
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
					<Button variant="primary" icon={<Plus />} onClick={() => openForm()}>
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
							<div className="border rounded-lg overflow-x-auto">
								<div className="min-w-[800px]">
									<div className="flex items-center gap-4 py-2 px-4 border-b bg-kumo-tint/50 text-sm font-medium text-kumo-subtle">
										<div className="flex-1">{t`Source`}</div>
										<div className="w-8 text-center" />
										<div className="flex-1">{t`Destination`}</div>
										<div className="w-36 shrink-0">{t`Group`}</div>
										<div className="w-14 text-center">{t`Code`}</div>
										<div className="w-16 text-end">{t`Hits`}</div>
										<div className="w-20 text-center">{t`Status`}</div>
										<div className="w-20" />
									</div>
									{redirects.map((r) => (
										<div
											key={r.id}
											className={cn(
												"flex items-center gap-4 py-2 px-4 border-b last:border-0 text-sm",
												!r.enabled && "opacity-50",
											)}
										>
											<div className="flex-1 font-mono text-xs truncate" title={r.source}>
												<bdi dir="ltr">{r.source}</bdi>
											</div>
											<div className="w-8 text-center text-kumo-subtle">
												<ArrowNext size={14} />
											</div>
											<div className="flex-1 font-mono text-xs truncate" title={r.destination}>
												<bdi dir="ltr">{r.destination}</bdi>
											</div>
											<div
												className="w-36 shrink-0 truncate text-kumo-subtle"
												title={r.groupName ?? undefined}
											>
												{r.groupName ? (
													<bdi>{r.groupName}</bdi>
												) : (
													<>
														<span aria-hidden="true">—</span>
														<span className="sr-only">{t`No group`}</span>
													</>
												)}
											</div>
											<div className="w-14 text-center">
												<Badge variant="secondary">{r.type}</Badge>
											</div>
											<div className="w-16 text-end tabular-nums text-kumo-subtle">{r.hits}</div>
											<div className="w-20 text-center">
												<Switch
													checked={r.enabled}
													onCheckedChange={(checked) =>
														toggleMutation.mutate({
															id: r.id,
															enabled: checked,
														})
													}
													aria-label={r.enabled ? t`Disable redirect` : t`Enable redirect`}
												/>
											</div>
											<div className="w-20 flex items-center justify-end gap-1">
												{loopRedirectIds.has(r.id) && (
													<span title={t`Part of a redirect loop`} className="me-1 inline-flex">
														<WarningCircle
															size={14}
															weight="fill"
															className="text-kumo-warning"
															role="img"
															aria-label={t`Part of a redirect loop`}
														/>
													</span>
												)}
												{r.auto && (
													<Badge variant="outline" className="me-1 text-xs">
														{t`auto`}
													</Badge>
												)}
												<button
													onClick={() => openForm({ redirect: r })}
													className="p-1 text-kumo-subtle hover:text-kumo-default"
													title={t`Edit redirect`}
													aria-label={t`Edit redirect ${r.source}`}
												>
													<PencilSimple size={14} />
												</button>
												<button
													onClick={() => setDeleteId(r.id)}
													className="p-1 text-kumo-subtle hover:text-kumo-danger"
													title={t`Delete redirect`}
													aria-label={t`Delete redirect ${r.source}`}
												>
													<Trash size={14} />
												</button>
											</div>
										</div>
									))}
								</div>
							</div>
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

			{/* Create and edit dialog */}
			<RedirectFormDialog
				key={form.visit}
				open={form.open}
				onClose={() => setForm((current) => ({ ...current, open: false }))}
				redirect={form.redirect}
				defaultSource={form.defaultSource}
			/>

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
