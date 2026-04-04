import { Badge, Button, Dialog, Input, Label, Switch } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowRight,
	MagnifyingGlass,
	Plus,
	ArrowsLeftRight,
	Trash,
	PencilSimple,
	X,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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
import { cn } from "../lib/utils.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";

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

	const createMutation = useMutation({
		mutationFn: (input: CreateRedirectInput) => createRedirect(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["redirects"] });
			onClose();
		},
	});

	const updateMutation = useMutation({
		mutationFn: (input: UpdateRedirectInput) => updateRedirect(redirect!.id, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["redirects"] });
			onClose();
		},
	});

	const mutation = isEdit ? updateMutation : createMutation;

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const input = {
			source: source.trim(),
			destination: destination.trim(),
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
						aria-label="Close"
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label="Close"
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
							</Button>
						)}
					/>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<Input
						label={t`Source path`}
						placeholder={t`/old-page or /blog/[slug]`}
						value={source}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSource(e.target.value)}
						required
					/>

					<Input
						label={t`Destination path`}
						placeholder={t`/new-page or /articles/[slug]`}
						value={destination}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDestination(e.target.value)}
						required
					/>

					<div className="grid grid-cols-2 gap-4">
						<div>
							<Label htmlFor="redirect-type">{t`Status code`}</Label>
							<select
								id="redirect-type"
								value={type}
								onChange={(e) => setType(e.target.value)}
								className="flex h-10 w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
							>
								<option value="301">{t`301 Permanent`}</option>
								<option value="302">{t`302 Temporary`}</option>
								<option value="307">{t`307 Temporary (Strict)`}</option>
								<option value="308">{t`308 Permanent (Strict)`}</option>
							</select>
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
}: {
	items: NotFoundSummary[];
	onCreateRedirect: (path: string) => void;
}) {
	const { t } = useLingui();
	if (items.length === 0) {
		return (
			<p className="text-sm text-kumo-subtle py-4 text-center">{t`No 404 errors recorded yet.`}</p>
		);
	}

	return (
		<div className="border rounded-lg">
			<div className="flex items-center gap-4 py-2 px-4 border-b bg-kumo-tint/50 text-sm font-medium text-kumo-subtle">
				<div className="flex-1">{t`Path`}</div>
				<div className="w-16 text-right">{t`Hits`}</div>
				<div className="w-32">{t`Last seen`}</div>
				<div className="w-8" />
			</div>
			{items.map((item) => (
				<div
					key={item.path}
					className="flex items-center gap-4 py-2 px-4 border-b last:border-0 text-sm"
				>
					<div className="flex-1 font-mono text-xs truncate">{item.path}</div>
					<div className="w-16 text-right tabular-nums">{item.count}</div>
					<div className="w-32 text-kumo-subtle text-xs">
						{(() => {
							const d = new Date(item.lastSeen);
							return Number.isNaN(d.getTime()) ? item.lastSeen : d.toLocaleDateString();
						})()}
					</div>
					<div className="w-8">
						<button
							onClick={() => onCreateRedirect(item.path)}
							className="text-kumo-subtle hover:text-kumo-default"
							title={t`Create redirect for this path`}
							aria-label={t`Create redirect for ${item.path}`}
						>
							<ArrowsLeftRight size={14} />
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

export function Redirects() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<TabKey>("redirects");
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [filterEnabled, setFilterEnabled] = useState<string>("all");
	const [filterAuto, setFilterAuto] = useState<string>("all");

	// Debounce search input
	useEffect(() => {
		const timer = setTimeout(setDebouncedSearch, 300, search);
		return () => clearTimeout(timer);
	}, [search]);

	// Dialog state
	const [showCreate, setShowCreate] = useState(false);
	const [editRedirect, setEditRedirect] = useState<Redirect | null>(null);
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const [prefillSource, setPrefillSource] = useState("");

	// Queries
	const enabledFilter = filterEnabled === "all" ? undefined : filterEnabled === "true";
	const autoFilter = filterAuto === "all" ? undefined : filterAuto === "true";

	const redirectsQuery = useQuery({
		queryKey: ["redirects", debouncedSearch, enabledFilter, autoFilter],
		queryFn: () =>
			fetchRedirects({
				search: debouncedSearch || undefined,
				enabled: enabledFilter,
				auto: autoFilter,
				limit: 100,
			}),
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
			void queryClient.invalidateQueries({ queryKey: ["redirects"] });
			setDeleteId(null);
		},
	});

	// Toggle enabled mutation
	const toggleMutation = useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			updateRedirect(id, { enabled }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["redirects"] });
		},
		onError: () => {
			void queryClient.invalidateQueries({ queryKey: ["redirects"] });
		},
	});

	function handleCreateFrom404(path: string) {
		setPrefillSource(path);
		setShowCreate(true);
		setTab("redirects");
	}

	const redirects = redirectsQuery.data?.items ?? [];

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">{t`Redirects`}</h1>
					<p className="text-kumo-subtle">{t`Manage URL redirects and view 404 errors.`}</p>
				</div>
				<Button icon={<Plus />} onClick={() => setShowCreate(true)}>
					{t`New Redirect`}
				</Button>
			</div>

			{/* Tabs */}
			<div className="flex gap-1 border-b">
				<button
					onClick={() => setTab("redirects")}
					className={cn(
						"px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
						tab === "redirects"
							? "border-kumo-brand text-kumo-brand"
							: "border-transparent text-kumo-subtle hover:text-kumo-default",
					)}
				>
					{t`Redirects`}
					{redirectsQuery.data && (
						<Badge variant="secondary" className="ml-2">
							{redirectsQuery.data.items.length}
							{redirectsQuery.data.nextCursor ? "+" : ""}
						</Badge>
					)}
				</button>
				<button
					onClick={() => setTab("404s")}
					className={cn(
						"px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
						tab === "404s"
							? "border-kumo-brand text-kumo-brand"
							: "border-transparent text-kumo-subtle hover:text-kumo-default",
					)}
				>
					{t`404 Errors`}
				</button>
			</div>

			{/* Tab content */}
			{tab === "redirects" && (
				<>
					{/* Filters */}
					<div className="flex items-center gap-4">
						<div className="relative flex-1 max-w-md">
							<MagnifyingGlass
								className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle"
								size={16}
							/>
							<Input
								placeholder={t`Search source or destination...`}
								className="pl-10"
								value={search}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
							/>
						</div>
						<select
							value={filterEnabled}
							onChange={(e) => setFilterEnabled(e.target.value)}
							className="h-10 rounded-md border border-kumo-line bg-kumo-base px-3 text-sm"
						>
							<option value="all">{t`All statuses`}</option>
							<option value="true">{t`Enabled`}</option>
							<option value="false">{t`Disabled`}</option>
						</select>
						<select
							value={filterAuto}
							onChange={(e) => setFilterAuto(e.target.value)}
							className="h-10 rounded-md border border-kumo-line bg-kumo-base px-3 text-sm"
						>
							<option value="all">{t`All types`}</option>
							<option value="false">{t`Manual`}</option>
							<option value="true">{t`Auto (slug change)`}</option>
						</select>
					</div>

					{/* Redirect list */}
					{redirectsQuery.isLoading ? (
						<div className="py-12 text-center text-kumo-subtle">{t`Loading redirects...`}</div>
					) : redirects.length === 0 ? (
						<div className="py-12 text-center text-kumo-subtle">
							<ArrowsLeftRight size={48} className="mx-auto mb-4 opacity-30" />
							<p className="text-lg font-medium">{t`No redirects yet`}</p>
							<p className="text-sm mt-1">{t`Create redirect rules to manage URL changes.`}</p>
						</div>
					) : (
						<div className="border rounded-lg">
							<div className="flex items-center gap-4 py-2 px-4 border-b bg-kumo-tint/50 text-sm font-medium text-kumo-subtle">
								<div className="flex-1">{t`Source`}</div>
								<div className="w-8 text-center" />
								<div className="flex-1">{t`Destination`}</div>
								<div className="w-14 text-center">{t`Code`}</div>
								<div className="w-16 text-right">{t`Hits`}</div>
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
										{r.source}
									</div>
									<div className="w-8 text-center text-kumo-subtle">
										<ArrowRight size={14} />
									</div>
									<div className="flex-1 font-mono text-xs truncate" title={r.destination}>
										{r.destination}
									</div>
									<div className="w-14 text-center">
										<Badge variant="secondary">{r.type}</Badge>
									</div>
									<div className="w-16 text-right tabular-nums text-kumo-subtle">{r.hits}</div>
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
										{r.auto && (
											<Badge variant="outline" className="mr-1 text-xs">
												auto
											</Badge>
										)}
										<button
											onClick={() => setEditRedirect(r)}
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
					)}
				</>
			)}

			{tab === "404s" && (
				<NotFoundPanel items={notFoundQuery.data ?? []} onCreateRedirect={handleCreateFrom404} />
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
