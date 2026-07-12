/**
 * Navigation settings (sidebar organizer)
 *
 * Admins arrange the site-wide sidebar here: create/rename/delete groups,
 * move and reorder items, hide items, and reset to defaults. Edits are a
 * local draft (lib/admin-nav-organizer.ts) — nothing changes until Save,
 * which PUTs the serialized config and invalidates the manifest so the
 * sidebar regroups live.
 *
 * Hiding is presentation only: hidden items stay reachable by URL and
 * searchable in the command palette. Dashboard, Settings, and this page
 * can't be hidden (lockout prevention), so they show no hide control.
 */

import { Badge, Button, Dialog, Input, Select, Switch, useKumoToastManager } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { ArrowDown, ArrowUp, Eye, EyeSlash, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	buildAdminNavModel,
	type AdminNavItem,
	type AdminNavModel,
} from "../../lib/admin-nav";
import {
	addOrganizerGroup,
	buildItemDefaultGroups,
	createOrganizerDraft,
	deleteOrganizerGroup,
	hideOrganizerItem,
	moveOrganizerGroup,
	moveOrganizerItem,
	moveOrganizerItemInGroup,
	organizerDraftsEqual,
	renameOrganizerGroup,
	serializeOrganizerDraft,
	setOrganizerGroupCollapsedByDefault,
	showOrganizerItem,
	type OrganizerDraft,
	type OrganizerGroup,
} from "../../lib/admin-nav-organizer";
import { fetchManifest } from "../../lib/api";
import { updateAdminNavigation } from "../../lib/api/admin-navigation.js";
import { useCurrentUser } from "../../lib/api/current-user";
import { usePluginAdmins } from "../../lib/plugin-context";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { DialogError, getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

const EMPTY_CONFIG = { version: 1 as const, groups: [], items: [] };

type GroupDialogState = { mode: "add" } | { mode: "rename"; groupId: string } | null;

/** Small name dialog shared by "Add group" and "Rename group". */
function GroupNameDialog({
	state,
	initialName,
	onClose,
	onSubmit,
}: {
	state: GroupDialogState;
	initialName: string;
	onClose: () => void;
	onSubmit: (name: string) => void;
}) {
	const { t } = useLingui();
	const [name, setName] = React.useState(initialName);

	// Re-seed the input whenever the dialog opens for a different target.
	React.useEffect(() => {
		setName(initialName);
	}, [initialName, state?.mode]);

	const submit = () => {
		if (name.trim()) onSubmit(name.trim());
	};

	return (
		<Dialog.Root open={state !== null} onOpenChange={(open) => !open && onClose()}>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">
					{state?.mode === "rename" ? t`Rename group` : t`Add group`}
				</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle">
					{t`Group names are shown as-is in the sidebar for every user.`}
				</Dialog.Description>
				<form
					className="mt-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<Input
						label={t`Group name`}
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={80}
						autoFocus
					/>
					<div className="mt-6 flex justify-end gap-2">
						<Button variant="secondary" type="button" onClick={onClose}>
							{t`Cancel`}
						</Button>
						<Button variant="primary" type="submit" disabled={!name.trim()}>
							{state?.mode === "rename" ? t`Rename` : t`Add group`}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

export function NavigationSettings() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const pluginAdmins = usePluginAdmins();

	const { data: user } = useCurrentUser();
	const userRole = user?.role ?? 0;

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	// The model needs the real role before it's usable here: seeding from
	// the pre-fetch role-0 fallback would filter every gated item out of
	// the draft and save a layout missing most of the sidebar.
	const model: AdminNavModel | null = React.useMemo(
		() =>
			manifest && user
				? buildAdminNavModel(manifest, { userRole, pluginAdmins, includeEmptyGroups: true })
				: null,
		[manifest, user, userRole, pluginAdmins],
	);

	// The draft seeds once from the first loaded model; manifest refetches
	// (e.g. after save) must not clobber in-progress edits.
	const [draft, setDraft] = React.useState<OrganizerDraft | null>(null);
	const [initialDraft, setInitialDraft] = React.useState<OrganizerDraft | null>(null);
	React.useEffect(() => {
		if (model && draft === null) {
			const seeded = createOrganizerDraft(model);
			setDraft(seeded);
			setInitialDraft(seeded);
		}
	}, [model, draft]);

	const itemsById = React.useMemo(() => {
		const map = new Map<string, AdminNavItem>();
		if (!model) return map;
		for (const group of model.groups) {
			for (const item of group.items) map.set(item.id, item);
		}
		for (const item of model.hiddenItems) map.set(item.id, item);
		return map;
	}, [model]);

	const defaultGroups = React.useMemo(
		() => (model ? buildItemDefaultGroups(model) : new Map<string, string>()),
		[model],
	);

	// Default group labels stay translatable; renames become site data.
	const defaultGroupLabels = React.useMemo(() => {
		const map = new Map<string, string | MessageDescriptor>();
		for (const group of model?.groups ?? []) {
			if (group.label !== undefined) map.set(group.id, group.label);
		}
		return map;
	}, [model]);

	function resolveText(label: string | MessageDescriptor | undefined): string {
		if (label === undefined) return "";
		return typeof label === "string" ? label : t(label);
	}

	function groupDisplayName(group: OrganizerGroup): string {
		return group.customLabel ?? resolveText(defaultGroupLabels.get(group.id)) ?? group.id;
	}

	function itemDisplayName(itemId: string): string {
		const item = itemsById.get(itemId);
		return item ? resolveText(item.label) : itemId;
	}

	const [groupDialog, setGroupDialog] = React.useState<GroupDialogState>(null);
	const [groupToDelete, setGroupToDelete] = React.useState<OrganizerGroup | null>(null);
	const [resetOpen, setResetOpen] = React.useState(false);

	const dirty = draft !== null && initialDraft !== null && !organizerDraftsEqual(draft, initialDraft);

	const saveMutation = useMutation({
		mutationFn: (current: OrganizerDraft) =>
			updateAdminNavigation(serializeOrganizerDraft(current)),
		onSuccess: (_config, current) => {
			setInitialDraft(current);
			void queryClient.invalidateQueries({ queryKey: ["manifest"] });
			toastManager.add({ title: t`Navigation saved`, variant: "success", timeout: 4000 });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to save navigation`,
				description: getMutationError(error) || t`An error occurred`,
				variant: "error",
				timeout: 5000,
			});
		},
	});

	const resetMutation = useMutation({
		mutationFn: () => updateAdminNavigation(EMPTY_CONFIG),
		onSuccess: async () => {
			setResetOpen(false);
			// Refetch first, then drop the draft so it reseeds from the
			// refreshed (default) manifest rather than the stale one.
			await queryClient.invalidateQueries({ queryKey: ["manifest"] });
			setDraft(null);
			setInitialDraft(null);
			toastManager.add({ title: t`Navigation reset to defaults`, variant: "success", timeout: 4000 });
		},
	});

	if (!model || !draft) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<BackToSettingsLink />
					<h1 className="text-2xl font-bold">{t`Navigation`}</h1>
				</div>
			</div>
		);
	}

	const groupSelectItems = Object.fromEntries(
		draft.groups.map((group) => [group.id, groupDisplayName(group)]),
	);

	function renderItemRow(group: OrganizerGroup, itemId: string, index: number) {
		const item = itemsById.get(itemId);
		const name = itemDisplayName(itemId);
		return (
			<li key={itemId} className="flex items-center justify-between gap-3 py-2">
				<span className="min-w-0 truncate text-sm">{name}</span>
				<span className="flex items-center gap-1">
					<Select
						aria-label={t`Move ${name} to group`}
						className="w-36"
						size="sm"
						value={group.id}
						onValueChange={(value) => {
							if (value && value !== group.id) {
								setDraft((prev) => prev && moveOrganizerItem(prev, itemId, value));
							}
						}}
						items={groupSelectItems}
					/>
					<Button
						variant="ghost"
						size="sm"
						aria-label={t`Move ${name} up`}
						disabled={index === 0}
						onClick={() => setDraft((prev) => prev && moveOrganizerItemInGroup(prev, itemId, -1))}
					>
						<ArrowUp className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label={t`Move ${name} down`}
						disabled={index === group.itemIds.length - 1}
						onClick={() => setDraft((prev) => prev && moveOrganizerItemInGroup(prev, itemId, 1))}
					>
						<ArrowDown className="h-4 w-4" />
					</Button>
					{item?.hideable !== false && (
						<Button
							variant="ghost"
							size="sm"
							aria-label={t`Hide ${name} from the sidebar`}
							onClick={() => setDraft((prev) => prev && hideOrganizerItem(prev, itemId))}
						>
							<EyeSlash className="h-4 w-4" />
						</Button>
					)}
				</span>
			</li>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<BackToSettingsLink />
				<h1 className="text-2xl font-bold">{t`Navigation`}</h1>
			</div>

			<p className="text-sm text-kumo-subtle">
				{t`Organize the admin sidebar for everyone on this site: group related items, reorder them, or hide what you don't use. Hidden items stay reachable from the command palette. Changes apply when you save.`}
			</p>

			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="primary"
					disabled={!dirty || saveMutation.isPending}
					onClick={() => saveMutation.mutate(draft)}
				>
					{saveMutation.isPending ? t`Saving...` : t`Save`}
				</Button>
				<Button variant="secondary" onClick={() => setGroupDialog({ mode: "add" })}>
					<Plus className="h-4 w-4" />
					{t`Add group`}
				</Button>
				<Button variant="secondary" onClick={() => setResetOpen(true)}>
					{t`Reset to defaults`}
				</Button>
				{dirty && <span className="text-sm text-kumo-subtle">{t`Unsaved changes`}</span>}
			</div>

			<div className="space-y-4">
				{draft.groups.map((group, groupIndex) => (
					<div key={group.id} className="rounded-lg border bg-kumo-base p-4">
						<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
							<div className="flex min-w-0 items-center gap-2">
								<h2 className="truncate font-semibold">{groupDisplayName(group)}</h2>
								{group.isDefault && <Badge variant="secondary">{t`Default`}</Badge>}
							</div>
							<div className="flex items-center gap-1">
								<Switch
									label={t`Start collapsed`}
									checked={group.collapsedByDefault}
									onCheckedChange={(checked) =>
										setDraft(
											(prev) => prev && setOrganizerGroupCollapsedByDefault(prev, group.id, checked),
										)
									}
								/>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t`Move group ${groupDisplayName(group)} up`}
									disabled={groupIndex === 0}
									onClick={() => setDraft((prev) => prev && moveOrganizerGroup(prev, group.id, -1))}
								>
									<ArrowUp className="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t`Move group ${groupDisplayName(group)} down`}
									disabled={groupIndex === draft.groups.length - 1}
									onClick={() => setDraft((prev) => prev && moveOrganizerGroup(prev, group.id, 1))}
								>
									<ArrowDown className="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									aria-label={t`Rename group ${groupDisplayName(group)}`}
									onClick={() => setGroupDialog({ mode: "rename", groupId: group.id })}
								>
									<PencilSimple className="h-4 w-4" />
								</Button>
								{!group.isDefault && (
									<Button
										variant="ghost"
										size="sm"
										aria-label={t`Delete group ${groupDisplayName(group)}`}
										onClick={() => setGroupToDelete(group)}
									>
										<Trash className="h-4 w-4" />
									</Button>
								)}
							</div>
						</div>
						{group.itemIds.length > 0 ? (
							<ul className="divide-y">
								{group.itemIds.map((itemId, index) => renderItemRow(group, itemId, index))}
							</ul>
						) : (
							<p className="py-2 text-sm text-kumo-subtle">
								{t`No items — this group won't appear in the sidebar until it has one.`}
							</p>
						)}
					</div>
				))}
			</div>

			{draft.hiddenIds.length > 0 && (
				<div className="rounded-lg border bg-kumo-base p-4">
					<div className="mb-2 flex items-center gap-2">
						<Eye className="h-4 w-4 text-kumo-subtle" />
						<h2 className="font-semibold">{t`Hidden from sidebar`}</h2>
					</div>
					<ul className="divide-y">
						{draft.hiddenIds.map((itemId) => (
							<li key={itemId} className="flex items-center justify-between gap-3 py-2">
								<span className="min-w-0 truncate text-sm">{itemDisplayName(itemId)}</span>
								<Button
									variant="secondary"
									size="sm"
									onClick={() =>
										setDraft((prev) => prev && showOrganizerItem(prev, itemId, defaultGroups))
									}
								>
									{t`Show`}
								</Button>
							</li>
						))}
					</ul>
				</div>
			)}

			<GroupNameDialog
				state={groupDialog}
				initialName={
					groupDialog?.mode === "rename"
						? (draft.groups.find((group) => group.id === groupDialog.groupId)?.customLabel ??
							resolveText(defaultGroupLabels.get(groupDialog.groupId)))
						: ""
				}
				onClose={() => setGroupDialog(null)}
				onSubmit={(name) => {
					setDraft((prev) => {
						if (!prev || !groupDialog) return prev;
						return groupDialog.mode === "add"
							? addOrganizerGroup(prev, name)
							: renameOrganizerGroup(prev, groupDialog.groupId, name);
					});
					setGroupDialog(null);
				}}
			/>

			<ConfirmDialog
				open={groupToDelete !== null}
				onClose={() => setGroupToDelete(null)}
				title={t`Delete group?`}
				description={t`Items in ${groupToDelete ? groupDisplayName(groupToDelete) : ""} move back to their default groups. This takes effect when you save.`}
				confirmLabel={t`Delete group`}
				pendingLabel={t`Deleting...`}
				isPending={false}
				error={null}
				onConfirm={() => {
					setDraft((prev) => {
						if (!prev || !groupToDelete) return prev;
						return deleteOrganizerGroup(prev, groupToDelete.id, defaultGroups);
					});
					setGroupToDelete(null);
				}}
			/>

			<ConfirmDialog
				open={resetOpen}
				onClose={() => setResetOpen(false)}
				title={t`Reset navigation to defaults?`}
				description={t`Removes all custom groups, ordering, and hidden items for every user on this site.`}
				confirmLabel={t`Reset`}
				pendingLabel={t`Resetting...`}
				isPending={resetMutation.isPending}
				error={resetMutation.error}
				onConfirm={() => resetMutation.mutate()}
			/>

			<DialogError message={getMutationError(saveMutation.error)} />
		</div>
	);
}
