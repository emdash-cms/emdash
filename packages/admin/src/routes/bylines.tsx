import { Button, Input, InputArea, Loader, Select, Switch } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DialogError, getMutationError } from "../components/DialogError.js";
import {
	createByline,
	deleteByline,
	fetchBylines,
	fetchUsers,
	updateByline,
	type BylineSummary,
	type UserListItem,
} from "../lib/api";

interface BylineFormState {
	slug: string;
	displayName: string;
	bio: string;
	websiteUrl: string;
	userId: string | null;
	isGuest: boolean;
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
		};
	}

	return {
		slug: byline.slug,
		displayName: byline.displayName,
		bio: byline.bio ?? "",
		websiteUrl: byline.websiteUrl ?? "",
		userId: byline.userId,
		isGuest: byline.isGuest,
	};
}

function getUserLabel(user: UserListItem): string {
	if (user.name) return `${user.name} (${user.email})`;
	return user.email;
}

export function BylinesPage() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [search, setSearch] = React.useState("");
	const [guestFilter, setGuestFilter] = React.useState<"all" | "guest" | "linked">("all");
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
	const [allItems, setAllItems] = React.useState<BylineSummary[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined);

	const { data, isLoading, error } = useQuery({
		queryKey: ["bylines", search, guestFilter],
		queryFn: () =>
			fetchBylines({
				search: search || undefined,
				isGuest: guestFilter === "all" ? undefined : guestFilter === "guest",
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

	const loadMoreMutation = useMutation({
		mutationFn: async () => {
			if (!nextCursor) return null;
			return fetchBylines({
				search: search || undefined,
				isGuest: guestFilter === "all" ? undefined : guestFilter === "guest",
				limit: 50,
				cursor: nextCursor,
			});
		},
		onSuccess: (result) => {
			if (result) {
				setAllItems((prev) => [...prev, ...result.items]);
				setNextCursor(result.nextCursor);
			}
		},
	});

	const items = allItems;
	const selected = items.find((item) => item.id === selectedId) ?? null;

	const [form, setForm] = React.useState<BylineFormState>(() => toFormState(null));

	React.useEffect(() => {
		setForm(toFormState(selected));
	}, [selectedId, selected]);

	const createMutation = useMutation({
		mutationFn: () =>
			createByline({
				slug: form.slug,
				displayName: form.displayName,
				bio: form.bio || null,
				websiteUrl: form.websiteUrl || null,
				userId: form.userId,
				isGuest: form.isGuest,
			}),
		onSuccess: (created) => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
			setSelectedId(created.id);
		},
	});

	const updateMutation = useMutation({
		mutationFn: () => {
			if (!selectedId) throw new Error("No byline selected");
			return updateByline(selectedId, {
				slug: form.slug,
				displayName: form.displayName,
				bio: form.bio || null,
				websiteUrl: form.websiteUrl || null,
				userId: form.userId,
				isGuest: form.isGuest,
			});
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["bylines"] });
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
	const mutationError = createMutation.error || updateMutation.error || deleteMutation.error;

	return (
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
					{items.length === 0 && <p className="text-sm text-kumo-subtle">{t`No bylines found`}</p>}
					{nextCursor && (
						<Button
							variant="secondary"
							className="w-full mt-2"
							onClick={() => loadMoreMutation.mutate()}
							disabled={loadMoreMutation.isPending}
						>
							{loadMoreMutation.isPending ? t`Loading...` : t`Load more`}
						</Button>
					)}
				</div>
			</div>

			<div className="rounded-lg border p-6">
				<h2 className="text-lg font-semibold mb-4">
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
