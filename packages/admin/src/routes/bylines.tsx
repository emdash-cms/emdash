import { Button, Input, InputArea, Loader, Switch } from "@cloudflare/kumo";
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
		return <div className="text-kumo-danger">Failed to load bylines: {error.message}</div>;
	}

	const isSaving = createMutation.isPending || updateMutation.isPending;
	const mutationError = createMutation.error || updateMutation.error || deleteMutation.error;

	return (
		<div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
			<div className="rounded-lg border p-4">
				<div className="mb-4 space-y-2">
					<Input
						placeholder="Search bylines"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
					<div className="flex items-center gap-2">
						<select
							aria-label="Filter byline type"
							value={guestFilter}
							onChange={(e) => setGuestFilter(e.target.value as "all" | "guest" | "linked")}
							className="w-full rounded border bg-kumo-base px-3 py-2 text-sm"
						>
							<option value="all">All bylines</option>
							<option value="guest">Guest only</option>
							<option value="linked">Linked only</option>
						</select>
						<Button
							variant="secondary"
							onClick={() => {
								setSelectedId(null);
								setForm(toFormState(null));
							}}
						>
							New
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
								className={`w-full rounded border p-3 text-left ${
									active ? "border-kumo-brand bg-kumo-brand/10" : "border-kumo-line"
								}`}
							>
								<p className="font-medium">{item.displayName}</p>
								<p className="text-xs text-kumo-subtle">
									{item.slug}
									{item.isGuest ? " - Guest" : item.userId ? " - Linked" : ""}
								</p>
							</button>
						);
					})}
					{items.length === 0 && <p className="text-sm text-kumo-subtle">No bylines found</p>}
					{nextCursor && (
						<Button
							variant="secondary"
							className="w-full mt-2"
							onClick={() => loadMoreMutation.mutate()}
							disabled={loadMoreMutation.isPending}
						>
							{loadMoreMutation.isPending ? "Loading..." : "Load more"}
						</Button>
					)}
				</div>
			</div>

			<div className="rounded-lg border p-6">
				<h2 className="text-lg font-semibold mb-4">
					{selected ? `Edit ${selected.displayName}` : "Create byline"}
				</h2>

				<div className="space-y-4">
					<Input
						label="Display name"
						value={form.displayName}
						onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
					/>
					<Input
						label="Slug"
						value={form.slug}
						onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
					/>
					<Input
						label="Website URL"
						value={form.websiteUrl}
						onChange={(e) => setForm((prev) => ({ ...prev, websiteUrl: e.target.value }))}
					/>
					<InputArea
						label="Bio"
						value={form.bio}
						onChange={(e) => setForm((prev) => ({ ...prev, bio: e.target.value }))}
						rows={5}
					/>
					<div>
						<label className="text-sm font-medium">Linked user</label>
						<select
							value={form.userId ?? ""}
							onChange={(e) =>
								setForm((prev) => ({
									...prev,
									userId: e.target.value || null,
									isGuest: e.target.value ? false : prev.isGuest,
								}))
							}
							className="mt-1 w-full rounded border bg-kumo-base px-3 py-2 text-sm"
						>
							<option value="">No linked user</option>
							{users.map((user) => (
								<option key={user.id} value={user.id}>
									{getUserLabel(user)}
								</option>
							))}
						</select>
					</div>
					<Switch
						label="Guest byline"
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
							{isSaving ? "Saving..." : selected ? "Save" : "Create"}
						</Button>

						{selected && (
							<Button
								variant="destructive"
								onClick={() => setShowDeleteConfirm(true)}
								disabled={deleteMutation.isPending}
							>
								Delete
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
				title="Delete Byline?"
				description="This removes the byline profile. Content byline links are removed and lead pointers are cleared."
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteMutation.mutate()}
			/>
		</div>
	);
}
