/**
 * Menu Editor component
 *
 * Edit menu items with basic reordering (simplified version without drag-and-drop)
 */

import { Button, Input, LayerDialog, Select, useKumoToastManager } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	Trash,
	CaretUp,
	CaretDown,
	Link as LinkIcon,
	File as FileIcon,
	Pencil,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchMenu,
	updateMenu,
	createMenuItem,
	deleteMenuItem,
	updateMenuItem,
	reorderMenuItems,
	fetchMenuTranslations,
	createMenuTranslation,
	type CreateMenuItemInput,
	type MenuItem,
	type UpdateMenuItemInput,
} from "../lib/api";
import { fetchManifest } from "../lib/api/client.js";
import { guardUnsavedInput, revealErrors, useSingleFlight } from "../lib/dialog-form.js";
import { isSafeHref } from "../lib/url.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ContentPickerModal } from "./ContentPickerModal";
import { DialogError, getMutationError } from "./DialogError.js";
import { HelpLabel } from "./FieldHelpLabel.js";
import { useI18nConfig } from "./LocaleSwitcher.js";
import { RouterLinkButton } from "./RouterLinkButton.js";
import { TranslationsPanel } from "./TranslationsPanel.js";

/** A menu item with its nesting depth, in parent-then-children display order. */
interface DisplayItem {
	item: MenuItem;
	depth: number;
}

/**
 * Flattens items into parent-then-children display order. Guards against
 * cyclic parentId data from older API writes with a visited set.
 */
function buildDisplayList(items: MenuItem[]): DisplayItem[] {
	const childrenByParent = new Map<string | null, MenuItem[]>();
	for (const item of items) {
		const siblings = childrenByParent.get(item.parentId) ?? [];
		siblings.push(item);
		childrenByParent.set(item.parentId, siblings);
	}

	const result: DisplayItem[] = [];
	const visited = new Set<string>();
	function visit(parentId: string | null, depth: number) {
		for (const item of childrenByParent.get(parentId) ?? []) {
			if (visited.has(item.id)) continue;
			visited.add(item.id);
			result.push({ item, depth });
			visit(item.id, depth + 1);
		}
	}
	visit(null, 0);
	return result;
}

/** IDs of `rootId` and everything nested under it, so it can't become its own descendant's child. */
function getSelfAndDescendantIds(items: MenuItem[], rootId: string): Set<string> {
	const childrenByParent = new Map<string | null, MenuItem[]>();
	for (const item of items) {
		const siblings = childrenByParent.get(item.parentId) ?? [];
		siblings.push(item);
		childrenByParent.set(item.parentId, siblings);
	}

	const ids = new Set<string>([rootId]);
	function visit(parentId: string) {
		for (const child of childrenByParent.get(parentId) ?? []) {
			if (ids.has(child.id)) continue;
			ids.add(child.id);
			visit(child.id);
		}
	}
	visit(rootId);
	return ids;
}

interface MenuItemFormValues {
	label: string;
	url: string;
	target: string;
	cssClasses: string;
	parentId: string;
}

type MenuItemField = "label" | "url";

function toMenuItemFormValues(item: MenuItem | null): MenuItemFormValues {
	return {
		label: item?.label ?? "",
		url: item?.customUrl || "",
		target: item?.target || "",
		cssClasses: item?.cssClasses ?? "",
		parentId: item?.parentId ?? "",
	};
}

function sameMenuItemValues(a: MenuItemFormValues, b: MenuItemFormValues): boolean {
	return (
		a.label === b.label &&
		a.url === b.url &&
		a.target === b.target &&
		a.cssClasses === b.cssClasses &&
		a.parentId === b.parentId
	);
}

function menuItemProblems(
	values: MenuItemFormValues,
	hasUrl: boolean,
): Partial<Record<MenuItemField, MessageDescriptor>> {
	const problems: Partial<Record<MenuItemField, MessageDescriptor>> = {};
	if (!values.label.trim()) problems.label = msg`Enter a label.`;
	if (hasUrl) {
		const url = values.url.trim();
		if (!url) problems.url = msg`Enter a URL.`;
		else if (url.startsWith("//") || url.startsWith("/\\")) {
			problems.url = msg`Enter a path that starts with a single /.`;
		} else if (!isSafeHref(url)) {
			problems.url = msg`Enter a URL that starts with https://, http://, mailto:, tel:, /, or #.`;
		}
	}
	return problems;
}

const EMPTY_MENU_ITEM = toMenuItemFormValues(null);

export function MenuEditor() {
	const { t } = useLingui();
	const { name } = useParams({ from: "/_admin/menus/$name" });
	const search = useSearch({ from: "/_admin/menus/$name" });
	const routeLocale = search.locale;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [isAddOpen, setIsAddOpen] = React.useState(false);
	const [isRenameOpen, setIsRenameOpen] = React.useState(false);
	const [isContentPickerOpen, setIsContentPickerOpen] = React.useState(false);
	const [editingItem, setEditingItem] = React.useState<MenuItem | null>(null);
	const [deleteItemId, setDeleteItemId] = React.useState<string | null>(null);
	const [localItems, setLocalItems] = React.useState<MenuItem[]>([]);
	const [renameLabel, setRenameLabel] = React.useState("");
	const [renameSubmitted, setRenameSubmitted] = React.useState(false);
	const [addValues, setAddValues] = React.useState(EMPTY_MENU_ITEM);
	const [addSubmitted, setAddSubmitted] = React.useState(false);
	const [editValues, setEditValues] = React.useState(EMPTY_MENU_ITEM);
	const [editSubmitted, setEditSubmitted] = React.useState(false);
	const renameFormId = React.useId();
	const addFormId = React.useId();
	const editFormId = React.useId();

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});
	const i18n = useI18nConfig(manifest);

	const { data: menu, isLoading } = useQuery({
		queryKey: ["menu", name, routeLocale ?? null],
		queryFn: () => fetchMenu(name, { locale: routeLocale }),
		staleTime: Infinity,
	});

	// The locale we lock mutations to: explicit URL param wins; else fall back
	// to whatever the loaded menu row says (handles entry from the old /menus/$name
	// URL without a locale query).
	const menuLocale = routeLocale ?? menu?.locale;

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

	// Sync local items with fetched data. An item whose parent is missing is
	// edited as a top-level item, which is where the site renders it.
	React.useEffect(() => {
		if (menu?.items) {
			const ids = new Set(menu.items.map((item) => item.id));
			setLocalItems(
				menu.items.map((item) =>
					item.parentId === null || ids.has(item.parentId) ? item : { ...item, parentId: null },
				),
			);
		}
	}, [menu]);

	const createMutation = useMutation({
		mutationFn: (input: CreateMenuItemInput) => createMenuItem(name, input, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			setIsAddOpen(false);
			toastManager.add({ title: t`Item added`, description: t`Menu item has been added.` });
		},
	});
	const submitAdd = useSingleFlight((input: CreateMenuItemInput) =>
		createMutation.mutateAsync(input),
	);

	// The content picker has closed by the time this request settles, so it
	// reports by toast instead of in a dialog.
	const addContentMutation = useMutation({
		mutationFn: (input: CreateMenuItemInput) => createMenuItem(name, input, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			toastManager.add({ title: t`Item added`, description: t`Menu item has been added.` });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Couldn’t add the menu item`,
				description: getMutationError(error),
				variant: "error",
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (itemId: string) => deleteMenuItem(name, itemId, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			setDeleteItemId(null);
			toastManager.add({
				title: t`Item deleted`,
				description: t`Menu item has been deleted.`,
			});
		},
	});

	const updateMutation = useMutation({
		mutationFn: ({
			itemId,
			input,
		}: {
			itemId: string;
			input: Parameters<typeof updateMenuItem>[2];
		}) => updateMenuItem(name, itemId, input, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			setEditingItem(null);
			toastManager.add({
				title: t`Item updated`,
				description: t`Menu item has been updated.`,
			});
		},
	});
	const submitUpdate = useSingleFlight((args: { itemId: string; input: UpdateMenuItemInput }) =>
		updateMutation.mutateAsync(args),
	);

	const reorderMutation = useMutation({
		mutationFn: (input: Parameters<typeof reorderMenuItems>[1]) =>
			reorderMenuItems(name, input, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			toastManager.add({
				title: t`Order saved`,
				description: t`Menu order has been updated.`,
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

	const setAddField = (field: keyof MenuItemFormValues, value: string) =>
		setAddValues((values) => ({ ...values, [field]: value }));
	const setEditField = (field: keyof MenuItemFormValues, value: string) =>
		setEditValues((values) => ({ ...values, [field]: value }));

	const handleAddOpenChange = (open: boolean) => {
		setIsAddOpen(open);
		if (!open) return;
		setAddValues(EMPTY_MENU_ITEM);
		setAddSubmitted(false);
		createMutation.reset();
	};

	const addProblems = menuItemProblems(addValues, true);
	const addErrors = addSubmitted ? addProblems : {};

	const handleAddCustomLink = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (createMutation.isPending) return;
		if (Object.keys(addProblems).length > 0) {
			revealErrors(e.currentTarget, () => setAddSubmitted(true));
			return;
		}
		submitAdd({
			type: "custom",
			label: addValues.label,
			customUrl: addValues.url.trim(),
			target: addValues.target || undefined,
			cssClasses: addValues.cssClasses.trim() || undefined,
		});
	};

	const handleAddContent = (item: { collection: string; id: string; title: string }) => {
		// The API's menuItemTypeEnum accepts singular values
		// ("custom" | "page" | "post" | "taxonomy" | "collection"), but the
		// ContentPickerModal hands us the collection slug (e.g. "pages",
		// "posts", or any custom collection slug). Map the slug to the
		// matching enum value and let the API resolve the real URL from
		// referenceCollection + referenceId.
		const type =
			item.collection === "pages" ? "page" : item.collection === "posts" ? "post" : "collection";
		addContentMutation.mutate({
			type,
			label: item.title,
			referenceCollection: item.collection,
			referenceId: item.id,
		});
	};

	const openEditItem = (item: MenuItem) => {
		setEditingItem(item);
		setEditValues(toMenuItemFormValues(item));
		setEditSubmitted(false);
		updateMutation.reset();
	};

	const editProblems = menuItemProblems(editValues, editingItem?.type === "custom");
	const editErrors = editSubmitted ? editProblems : {};
	const editDirty =
		editingItem !== null && !sameMenuItemValues(editValues, toMenuItemFormValues(editingItem));

	const handleUpdateItem = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!editingItem || updateMutation.isPending) return;
		if (Object.keys(editProblems).length > 0) {
			revealErrors(e.currentTarget, () => setEditSubmitted(true));
			return;
		}
		const cssClasses = editValues.cssClasses.trim();
		submitUpdate({
			itemId: editingItem.id,
			input: {
				label: editValues.label,
				customUrl: editingItem.type === "custom" ? editValues.url.trim() : undefined,
				target: editValues.target || undefined,
				cssClasses: cssClasses === (editingItem.cssClasses ?? "") ? undefined : cssClasses,
				parentId: editValues.parentId || null,
			},
		});
	};

	// Moves an item relative to its siblings (same parentId) only, so reordering
	// can't accidentally move an item into a different parent's children.
	const moveItem = (itemId: string, direction: "up" | "down") => {
		const currentItem = localItems.find((i) => i.id === itemId);
		if (!currentItem) return;

		const siblings = localItems.filter((i) => i.parentId === currentItem.parentId);
		const siblingIndex = siblings.findIndex((i) => i.id === itemId);
		const targetSiblingIndex = direction === "up" ? siblingIndex - 1 : siblingIndex + 1;
		if (targetSiblingIndex < 0 || targetSiblingIndex >= siblings.length) return;
		const targetItem = siblings[targetSiblingIndex];
		if (!targetItem) return;

		const currentPos = localItems.findIndex((i) => i.id === currentItem.id);
		const targetPos = localItems.findIndex((i) => i.id === targetItem.id);
		const newItems = [...localItems];
		newItems[currentPos] = targetItem;
		newItems[targetPos] = currentItem;

		// Update sort orders
		const reorderedItems = newItems.map((item, i) => ({
			id: item.id,
			parentId: item.parentId,
			sortOrder: i,
		}));

		setLocalItems(newItems);
		reorderMutation.mutate({ items: reorderedItems });
	};

	const displayList = React.useMemo(() => buildDisplayList(localItems), [localItems]);

	const parentOptions = React.useMemo(() => {
		if (!editingItem) return [];
		const excluded = getSelfAndDescendantIds(localItems, editingItem.id);
		return [
			{ value: "", label: t`No parent (top level)` },
			...buildDisplayList(localItems)
				.filter(({ item }) => !excluded.has(item.id))
				.map(({ item, depth }) => ({
					value: item.id,
					label: <span style={{ marginInlineStart: `${depth * 1.5}rem` }}>{item.label}</span>,
				})),
		];
	}, [editingItem, localItems, t]);

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

	return (
		<div className="space-y-6">
			<header className="space-y-3">
				<RouterLinkButton
					to="/menus"
					variant="ghost"
					size="sm"
					className="h-7 px-1.5 text-sm"
					icon={<ArrowPrev className="size-3.5" aria-hidden="true" />}
					aria-label={t`Back to menus`}
				>
					{t`Back`}
				</RouterLinkButton>
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div className="min-w-0">
						<div className="flex min-w-0 items-start gap-1.5">
							<h1 className="min-w-0 break-words text-2xl font-semibold leading-tight">
								{menu.label}
							</h1>
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
									<LayerDialog.Body>
										<form
											id={renameFormId}
											noValidate
											onSubmit={handleRename}
											className="grid gap-5"
										>
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
						</div>
						<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">{t`Edit menu items`}</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							icon={<FileIcon />}
							variant="secondary"
							onClick={() => setIsContentPickerOpen(true)}
						>
							{t`Add Content`}
						</Button>
						<LayerDialog.Root
							open={isAddOpen}
							{...guardUnsavedInput(
								!sameMenuItemValues(addValues, EMPTY_MENU_ITEM),
								handleAddOpenChange,
							)}
							dismissDisabled={createMutation.isPending}
						>
							<LayerDialog.Trigger
								render={(props) => (
									<Button {...props} variant="secondary" icon={<Plus />}>
										{t`Add Custom Link`}
									</Button>
								)}
							/>
							<LayerDialog.Content>
								<LayerDialog.Title>{t`Add Custom Link`}</LayerDialog.Title>
								<LayerDialog.Body>
									<form
										id={addFormId}
										noValidate
										onSubmit={handleAddCustomLink}
										className="grid gap-5"
									>
										<Input
											label={t`Label`}
											name="label"
											required
											placeholder={t`Home`}
											value={addValues.label}
											onChange={(e) => setAddField("label", e.target.value)}
											error={addErrors.label && t(addErrors.label)}
											aria-invalid={addErrors.label ? true : undefined}
										/>
										<Input
											dir="ltr"
											label={t`URL`}
											name="url"
											type="text"
											required
											placeholder={t`https://example.com or /about`}
											value={addValues.url}
											onChange={(e) => setAddField("url", e.target.value)}
											error={addErrors.url && t(addErrors.url)}
											aria-invalid={addErrors.url ? true : undefined}
										/>
										<Select
											label={t`Target`}
											className="w-full"
											name="target"
											value={addValues.target}
											onValueChange={(v) => setAddField("target", v ?? "")}
											items={{ "": t`Same window`, _blank: t`New window` }}
										>
											<Select.Option value="">{t`Same window`}</Select.Option>
											<Select.Option value="_blank">{t`New window`}</Select.Option>
										</Select>
										<Input
											label={
												<HelpLabel
													help={t`Separate class names with spaces. Themes can use them to style the link.`}
												>
													{t`CSS classes`}
												</HelpLabel>
											}
											aria-label={t`CSS classes`}
											name="cssClasses"
											dir="ltr"
											value={addValues.cssClasses}
											onChange={(e) => setAddField("cssClasses", e.target.value)}
										/>
										<DialogError message={getMutationError(createMutation.error)} />
									</form>
								</LayerDialog.Body>
								<LayerDialog.Actions dismissLabel={t`Cancel`}>
									<LayerDialog.Action
										type="submit"
										form={addFormId}
										disabled={createMutation.isPending}
									>
										{createMutation.isPending ? t`Adding...` : t`Add`}
									</LayerDialog.Action>
								</LayerDialog.Actions>
							</LayerDialog.Content>
						</LayerDialog.Root>
					</div>
				</div>
			</header>

			<ContentPickerModal
				open={isContentPickerOpen}
				onOpenChange={setIsContentPickerOpen}
				onConfirm={(rows) => {
					const item = rows[0];
					if (item) handleAddContent(item);
				}}
			/>

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

			{localItems.length === 0 ? (
				<div className="border rounded-lg p-12 text-center">
					<LinkIcon className="mx-auto h-12 w-12 text-kumo-subtle mb-4" />
					<h3 className="text-lg font-semibold mb-2">{t`No menu items yet`}</h3>
					<p className="text-kumo-subtle mb-4">{t`Add links to build your navigation menu`}</p>
					<div className="flex justify-center gap-2">
						<Button
							icon={<FileIcon />}
							variant="secondary"
							onClick={() => setIsContentPickerOpen(true)}
						>
							{t`Add Content`}
						</Button>
						<Button variant="secondary" icon={<Plus />} onClick={() => handleAddOpenChange(true)}>
							{t`Add Custom Link`}
						</Button>
					</div>
				</div>
			) : (
				<div className="space-y-2">
					{displayList.map(({ item, depth }) => {
						const siblings = localItems.filter((i) => i.parentId === item.parentId);
						const siblingIndex = siblings.findIndex((i) => i.id === item.id);
						return (
							<div
								key={item.id}
								className="border rounded-lg p-4 flex items-center justify-between"
								style={{ marginInlineStart: `${depth * 1.5}rem` }}
							>
								<div className="flex-1">
									<div className="font-medium">{item.label}</div>
									<div className="text-sm text-kumo-subtle">
										{item.type === "custom" ? (
											item.customUrl
										) : (
											<span className="inline-flex items-center rounded-full bg-kumo-brand/10 px-2 py-0.5 text-xs font-medium text-kumo-link">
												{item.referenceCollection ?? item.type}
											</span>
										)}
										{item.target === "_blank" && t` (opens in new window)`}
										{item.cssClasses && (
											<>
												<span aria-hidden="true"> · </span>
												<span className="sr-only">{t`CSS classes:`} </span>
												<code dir="ltr" className="text-xs">
													{item.cssClasses}
												</code>
											</>
										)}
									</div>
								</div>
								<div className="flex gap-2">
									<Button
										variant="ghost"
										size="sm"
										aria-label={t`Move up`}
										onClick={() => moveItem(item.id, "up")}
										disabled={siblingIndex === 0}
									>
										<CaretUp className="h-4 w-4" />
									</Button>
									<Button
										variant="ghost"
										size="sm"
										aria-label={t`Move down`}
										onClick={() => moveItem(item.id, "down")}
										disabled={siblingIndex === siblings.length - 1}
									>
										<CaretDown className="h-4 w-4" />
									</Button>
									<Button variant="outline" size="sm" onClick={() => openEditItem(item)}>
										{t`Edit`}
									</Button>
									<Button
										variant="outline"
										size="sm"
										aria-label={t`Delete`}
										onClick={() => setDeleteItemId(item.id)}
									>
										<Trash className="h-4 w-4" />
									</Button>
								</div>
								<ConfirmDialog
									open={deleteItemId === item.id}
									onClose={() => {
										setDeleteItemId(null);
										deleteMutation.reset();
									}}
									title={t`Delete menu item?`}
									description={
										localItems.some((i) => i.parentId === item.id)
											? t`"${item.label}" and its nested items will be removed from this menu. This action cannot be undone.`
											: t`"${item.label}" will be removed from this menu. This action cannot be undone.`
									}
									confirmLabel={t`Delete`}
									pendingLabel={t`Deleting...`}
									isPending={deleteMutation.isPending}
									error={deleteMutation.error}
									onConfirm={() => deleteMutation.mutate(item.id)}
								/>
							</div>
						);
					})}
				</div>
			)}

			<LayerDialog.Root
				open={editingItem !== null}
				{...guardUnsavedInput(editDirty, (open) => {
					if (!open) setEditingItem(null);
				})}
				dismissDisabled={updateMutation.isPending}
			>
				<LayerDialog.Content>
					<LayerDialog.Title>{t`Edit Menu Item`}</LayerDialog.Title>
					<LayerDialog.Body>
						{editingItem && (
							<form id={editFormId} noValidate onSubmit={handleUpdateItem} className="grid gap-5">
								<Input
									label={t`Label`}
									name="label"
									required
									value={editValues.label}
									onChange={(e) => setEditField("label", e.target.value)}
									error={editErrors.label && t(editErrors.label)}
									aria-invalid={editErrors.label ? true : undefined}
								/>
								{editingItem.type === "custom" && (
									<Input
										dir="ltr"
										label={t`URL`}
										name="url"
										type="text"
										required
										value={editValues.url}
										onChange={(e) => setEditField("url", e.target.value)}
										error={editErrors.url && t(editErrors.url)}
										aria-invalid={editErrors.url ? true : undefined}
									/>
								)}
								<Select
									label={t`Target`}
									className="w-full"
									name="target"
									value={editValues.target}
									onValueChange={(v) => setEditField("target", v ?? "")}
									items={{ "": t`Same window`, _blank: t`New window` }}
								>
									<Select.Option value="">{t`Same window`}</Select.Option>
									<Select.Option value="_blank">{t`New window`}</Select.Option>
								</Select>
								<Input
									label={
										<HelpLabel
											help={t`Separate class names with spaces. Themes can use them to style the link.`}
										>
											{t`CSS classes`}
										</HelpLabel>
									}
									aria-label={t`CSS classes`}
									name="cssClasses"
									dir="ltr"
									value={editValues.cssClasses}
									onChange={(e) => setEditField("cssClasses", e.target.value)}
								/>
								<Select
									label={t`Parent`}
									className="w-full"
									name="parentId"
									value={editValues.parentId}
									onValueChange={(v) => setEditField("parentId", v ?? "")}
									items={parentOptions}
								/>
								<DialogError message={getMutationError(updateMutation.error)} />
							</form>
						)}
					</LayerDialog.Body>
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action type="submit" form={editFormId} disabled={updateMutation.isPending}>
							{updateMutation.isPending ? t`Saving...` : t`Save`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				</LayerDialog.Content>
			</LayerDialog.Root>
		</div>
	);
}
