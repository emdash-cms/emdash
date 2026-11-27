import { Button, Input, LayerCard, LayerDialog, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Pencil, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import * as React from "react";

import {
	createMenuTranslation,
	deleteMenuItem,
	fetchMenu,
	fetchMenuTranslations,
	reorderMenuItems,
	updateMenu,
	type MenuItem,
	type MenuWithItems,
} from "../lib/api";
import { guardUnsavedInput, revealErrors, useSingleFlight } from "../lib/dialog-form.js";
import { useBreadcrumbLabel } from "./AdminBreadcrumbs.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { HelpLabel } from "./FieldHelpLabel.js";
import { useI18nConfig } from "./LocaleSwitcher.js";
import { AddMenuItemsDialog } from "./menus/AddMenuItemsDialog.js";
import { EditMenuItemDialog } from "./menus/EditMenuItemDialog.js";
import { useManifest } from "./menus/menu-item-target.js";
import { getDescendantIds, toReorderInput } from "./menus/menu-tree.js";
import { MenuNavPreview } from "./menus/MenuNavPreview.js";
import { MenuTree } from "./menus/MenuTree.js";
import { TranslationsPanel } from "./TranslationsPanel.js";

/** Items as the editor shows them: one whose parent is missing sits at the top level, where the site renders it. */
function normalizeItems(items: MenuItem[]): MenuItem[] {
	const ids = new Set(items.map((item) => item.id));
	return items.map((item) =>
		item.parentId === null || ids.has(item.parentId) ? item : { ...item, parentId: null },
	);
}

export function MenuEditor() {
	const { t } = useLingui();
	const { name } = useParams({ from: "/_admin/menus/$name" });
	const search = useSearch({ from: "/_admin/menus/$name" });
	const routeLocale = search.locale;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [isRenameOpen, setIsRenameOpen] = React.useState(false);
	const [renameLabel, setRenameLabel] = React.useState("");
	const [renameSubmitted, setRenameSubmitted] = React.useState(false);
	const renameFormId = React.useId();
	const [addDialog, setAddDialog] = React.useState<{
		open: boolean;
		key: number;
		parentId: string | null;
	}>({ open: false, key: 0, parentId: null });
	const [editing, setEditing] = React.useState<{ item: MenuItem | null; key: number }>({
		item: null,
		key: 0,
	});
	const [deleting, setDeleting] = React.useState<{ item: MenuItem | null; open: boolean }>({
		item: null,
		open: false,
	});
	const deleteItem = deleting.item;
	const closeDelete = () => setDeleting((previous) => ({ ...previous, open: false }));

	const i18n = useI18nConfig(useManifest());

	const menuKey = ["menu", name, routeLocale ?? null];
	const { data: menu, isLoading } = useQuery({
		queryKey: menuKey,
		queryFn: () => fetchMenu(name, { locale: routeLocale }),
		staleTime: Infinity,
		refetchOnMount: "always",
	});
	useBreadcrumbLabel(menu?.label ?? (isLoading ? undefined : t`Edit menu`));

	// The locale we lock mutations to: explicit URL param wins; else fall back
	// to whatever the loaded menu row says (handles entry from the old /menus/$name
	// URL without a locale query).
	const menuLocale = routeLocale ?? menu?.locale;

	const items = React.useMemo(() => normalizeItems(menu?.items ?? []), [menu]);

	const { data: translationsData } = useQuery({
		queryKey: ["menu-translations", name, menuLocale ?? null],
		queryFn: () => fetchMenuTranslations(name, { locale: menuLocale }),
		enabled: !!menu && !!i18n && i18n.locales.length > 1,
	});

	const translateMutation = useMutation({
		mutationFn: (targetLocale: string) =>
			createMenuTranslation(
				name,
				{ locale: targetLocale, label: menu?.label },
				{ locale: menuLocale },
			),
		onSuccess: (translated) => {
			void queryClient.invalidateQueries({ queryKey: ["menus"] });
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			void queryClient.invalidateQueries({ queryKey: ["menu-translations", name] });
			toastManager.add({
				title: t`Translation created`,
				description: t`Menu "${translated.label}" (${translated.locale.toUpperCase()}) created.`,
			});
			// Switch the editor to the new locale so the user keeps editing.
			void navigate({
				to: "/menus/$name",
				params: { name },
				search: { locale: translated.locale },
			});
		},
		onError: (error: Error) => {
			toastManager.add({
				title: t`Error`,
				description: error.message,
				variant: "error",
			});
		},
	});

	const renameMutation = useMutation({
		mutationFn: (label: string) => updateMenu(name, { label }, { locale: menuLocale }),
		onSuccess: (renamed) => {
			void queryClient.invalidateQueries({ queryKey: ["menus"] });
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			void queryClient.invalidateQueries({ queryKey: ["menu-translations", name] });
			setIsRenameOpen(false);
			toastManager.add({
				title: t`Menu renamed`,
				description: t`The menu is now called "${renamed.label}".`,
			});
		},
	});

	const submitRename = useSingleFlight((label: string) => renameMutation.mutateAsync(label));

	const handleRenameOpenChange = (open: boolean) => {
		setIsRenameOpen(open);
		if (!open) return;
		setRenameLabel(menu?.label ?? "");
		setRenameSubmitted(false);
		renameMutation.reset();
	};

	const renameError = renameSubmitted && !renameLabel.trim() ? t`Enter a label.` : undefined;

	const handleRename = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (renameMutation.isPending) return;
		const label = renameLabel.trim();
		if (!label) {
			revealErrors(e.currentTarget, () => setRenameSubmitted(true));
			return;
		}
		if (label === menu?.label) {
			setIsRenameOpen(false);
			return;
		}
		submitRename(label);
	};

	const deleteMutation = useMutation({
		mutationFn: (itemId: string) => deleteMenuItem(name, itemId, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			closeDelete();
			toastManager.add({
				title: t`Item deleted`,
				description: t`Menu item has been deleted.`,
			});
		},
	});

	const reorderMutationKey = ["menu-reorder", name];
	const reorderMutation = useMutation({
		mutationKey: reorderMutationKey,
		// Each body is the whole tree, so moves have to land in the order they
		// were made; a shared scope sends them one at a time.
		scope: { id: `menu-reorder:${name}` },
		mutationFn: (next: MenuItem[]) =>
			reorderMenuItems(name, toReorderInput(next), { locale: menuLocale }),
		onMutate: async (next) => {
			await queryClient.cancelQueries({ queryKey: menuKey });
			const previous = queryClient.getQueryData<MenuWithItems>(menuKey);
			if (previous) queryClient.setQueryData<MenuWithItems>(menuKey, { ...previous, items: next });
			return { previous };
		},
		onError: (error, _next, context) => {
			if (context?.previous) queryClient.setQueryData(menuKey, context.previous);
			toastManager.add({
				title: t`Couldn’t save the new order`,
				description: getMutationError(error),
				variant: "error",
			});
		},
		onSettled: () => {
			// onMutate can cancel the reload an add or delete started, so the last
			// queued move reloads the menu. The count includes this mutation: >1
			// means another move is queued and would replace what a reload shows.
			if (queryClient.isMutating({ mutationKey: reorderMutationKey }) > 1) return;
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
		},
	});

	const openAdd = (parentId: string | null) =>
		setAddDialog((previous) => ({ open: true, key: previous.key + 1, parentId }));
	const openEdit = (item: MenuItem) => setEditing((previous) => ({ item, key: previous.key + 1 }));

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-kumo-subtle">{t`Loading menu...`}</div>
			</div>
		);
	}

	if (!menu) {
		return (
			<div className="text-center py-12">
				<p className="text-kumo-subtle">{t`Menu not found`}</p>
			</div>
		);
	}

	const addButton = (
		<Button icon={<Plus aria-hidden="true" />} onClick={() => openAdd(null)}>
			{t`Add items`}
		</Button>
	);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-[min(100%,16rem)] flex-1 py-0.5 text-2xl leading-8">
					<h1 className="inline font-semibold break-words text-pretty">
						<bdi>{menu.label}</bdi>
					</h1>
					<span className="ms-1.5 inline-flex align-[0.0625rem]">
						<LayerDialog.Root
							open={isRenameOpen}
							{...guardUnsavedInput(renameLabel !== menu.label, handleRenameOpenChange)}
							dismissDisabled={renameMutation.isPending}
						>
							<LayerDialog.Trigger
								render={(props) => (
									<Button
										{...props}
										variant="ghost"
										shape="square"
										size="sm"
										className="size-7 shrink-0"
										icon={<Pencil className="size-4" aria-hidden="true" />}
										aria-label={t`Rename menu`}
									/>
								)}
							/>
							<LayerDialog.Content>
								<LayerDialog.Title>{t`Rename menu`}</LayerDialog.Title>
								<LayerDialog.Description>{t`Give this menu a new label.`}</LayerDialog.Description>
								<LayerDialog.Body>
									<form id={renameFormId} noValidate onSubmit={handleRename} className="grid gap-5">
										<Input
											label={
												<HelpLabel
													help={t`Shown in the admin. Some themes also show it on the site.`}
												>
													{t`Label`}
												</HelpLabel>
											}
											aria-label={t`Label`}
											name="label"
											required
											autoFocus
											value={renameLabel}
											onChange={(e) => setRenameLabel(e.target.value)}
											error={renameError}
											aria-invalid={renameError ? true : undefined}
										/>
										<DialogError message={getMutationError(renameMutation.error)} />
									</form>
								</LayerDialog.Body>
								<LayerDialog.Actions dismissLabel={t`Cancel`}>
									<LayerDialog.Action
										type="submit"
										form={renameFormId}
										disabled={renameMutation.isPending}
									>
										{renameMutation.isPending ? t`Saving...` : t`Save`}
									</LayerDialog.Action>
								</LayerDialog.Actions>
							</LayerDialog.Content>
						</LayerDialog.Root>
					</span>
				</div>
				{items.length > 0 && addButton}
			</header>

			{i18n && i18n.locales.length > 1 && menu ? (
				<div className="border rounded-lg p-4">
					<TranslationsPanel
						locales={i18n.locales}
						defaultLocale={i18n.defaultLocale}
						currentLocale={menu.locale}
						translations={
							translationsData?.translations.map((tr) => ({ id: tr.id, locale: tr.locale })) ?? [
								{ id: menu.id, locale: menu.locale },
							]
						}
						onOpen={(tr) =>
							navigate({
								to: "/menus/$name",
								params: { name },
								search: { locale: tr.locale },
							})
						}
						onCreate={(target) => translateMutation.mutate(target)}
						pendingLocale={
							translateMutation.isPending ? (translateMutation.variables ?? null) : null
						}
					/>
				</div>
			) : null}

			{items.length === 0 ? (
				<LayerCard className="flex flex-col items-center px-6 py-14 text-center">
					<MenuNavPreview
						items={[]}
						className="mb-6 w-72 max-w-full rounded-xl ring ring-kumo-line"
					/>
					<h2 className="text-lg leading-6 font-semibold">{t`No menu items yet`}</h2>
					<p className="mt-2 mb-5 max-w-sm text-sm leading-5 text-pretty text-kumo-subtle">
						{t`Add pages, posts, categories, or links to build this menu.`}
					</p>
					{addButton}
				</LayerCard>
			) : (
				<MenuTree
					items={items}
					locale={menuLocale}
					onReorder={(next) => reorderMutation.mutate(next)}
					onEdit={openEdit}
					onAddInside={(item) => openAdd(item.id)}
					onDelete={(item) => {
						deleteMutation.reset();
						setDeleting({ item, open: true });
					}}
				/>
			)}

			<AddMenuItemsDialog
				key={`add-${addDialog.key}`}
				open={addDialog.open}
				onOpenChange={(open) => setAddDialog((previous) => ({ ...previous, open }))}
				menuName={name}
				menuLocale={menuLocale}
				items={items}
				initialParentId={addDialog.parentId}
			/>

			<EditMenuItemDialog
				key={`edit-${editing.key}`}
				item={editing.item}
				menuName={name}
				menuLocale={menuLocale}
				onClose={() => setEditing((previous) => ({ ...previous, item: null }))}
			/>

			<ConfirmDialog
				open={deleting.open}
				onClose={closeDelete}
				title={t`Delete menu item?`}
				description={
					deleteItem && getDescendantIds(items, deleteItem.id).size > 0
						? t`"${deleteItem.label}" and its nested items will be removed from this menu. This action cannot be undone.`
						: t`"${deleteItem?.label ?? ""}" will be removed from this menu. This action cannot be undone.`
				}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteItem && deleteMutation.mutate(deleteItem.id)}
			/>
		</div>
	);
}
