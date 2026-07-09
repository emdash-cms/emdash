/**
 * Menu Editor component
 *
 * Edit menu items with basic reordering (simplified version without drag-and-drop)
 */

import { Button, Dialog, Input, Select, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	Trash,
	CaretUp,
	CaretDown,
	Link as LinkIcon,
	X,
	File as FileIcon,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchMenu,
	createMenuItem,
	deleteMenuItem,
	updateMenuItem,
	reorderMenuItems,
	fetchMenuTranslations,
	createMenuTranslation,
	type MenuItem,
} from "../lib/api";
import { fetchManifest } from "../lib/api/client.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { ContentPickerModal } from "./ContentPickerModal";
import { DialogError, getMutationError } from "./DialogError.js";
import { useI18nConfig } from "./LocaleSwitcher.js";
import { TranslationsPanel } from "./TranslationsPanel.js";

/** A menu item with its nesting depth, in parent-then-children display order. */
interface DisplayItem {
	item: MenuItem;
	depth: number;
}

/**
 * Flattens items into parent-then-children display order. Guards against
 * cyclic parentId data (not currently possible via this UI, but the API
 * doesn't validate against it either) with a visited set.
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

export function MenuEditor() {
	const { t } = useLingui();
	const { name } = useParams({ from: "/_admin/menus/$name" });
	const search = useSearch({ from: "/_admin/menus/$name" });
	const routeLocale = search.locale;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isAddOpen, setIsAddOpen] = React.useState(false);
	const [isContentPickerOpen, setIsContentPickerOpen] = React.useState(false);
	const [editingItem, setEditingItem] = React.useState<MenuItem | null>(null);
	const [localItems, setLocalItems] = React.useState<MenuItem[]>([]);
	const [addError, setAddError] = React.useState<string | null>(null);
	const [editError, setEditError] = React.useState<string | null>(null);

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
				type: "error",
			});
		},
	});

	// Sync local items with fetched data
	React.useEffect(() => {
		if (menu?.items) {
			setLocalItems(menu.items);
		}
	}, [menu]);

	const createMutation = useMutation({
		mutationFn: (input: Parameters<typeof createMenuItem>[1]) =>
			createMenuItem(name, input, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			setIsAddOpen(false);
			toastManager.add({ title: t`Item added`, description: t`Menu item has been added.` });
		},
		onError: (error: Error) => {
			setAddError(error.message);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (itemId: string) => deleteMenuItem(name, itemId, { locale: menuLocale }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			toastManager.add({
				title: t`Item deleted`,
				description: t`Menu item has been deleted.`,
			});
		},
		onError: (error: Error) => {
			toastManager.add({
				title: t`Error`,
				description: error.message,
				type: "error",
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
		onError: (error: Error) => {
			setEditError(error.message);
		},
	});

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
				type: "error",
			});
		},
	});

	const handleAddCustomLink = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setAddError(null);
		const formData = new FormData(e.currentTarget);
		const labelVal = formData.get("label");
		const urlVal = formData.get("url");
		const targetVal = formData.get("target");
		createMutation.mutate({
			type: "custom",
			label: typeof labelVal === "string" ? labelVal : "",
			customUrl: typeof urlVal === "string" ? urlVal : "",
			target: (typeof targetVal === "string" ? targetVal : "") || undefined,
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
		createMutation.mutate({
			type,
			label: item.title,
			referenceCollection: item.collection,
			referenceId: item.id,
		});
	};

	const handleUpdateItem = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setEditError(null);
		if (!editingItem) return;
		const formData = new FormData(e.currentTarget);
		const uLabelVal = formData.get("label");
		const uUrlVal = formData.get("url");
		const uTargetVal = formData.get("target");
		const uParentIdVal = formData.get("parentId");
		updateMutation.mutate({
			itemId: editingItem.id,
			input: {
				label: typeof uLabelVal === "string" ? uLabelVal : "",
				customUrl:
					editingItem.type === "custom" ? (typeof uUrlVal === "string" ? uUrlVal : "") : undefined,
				target: (typeof uTargetVal === "string" ? uTargetVal : "") || undefined,
				parentId: typeof uParentIdVal === "string" && uParentIdVal !== "" ? uParentIdVal : null,
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
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Button
						variant="ghost"
						size="sm"
						aria-label={t`Back`}
						onClick={() => navigate({ to: "/menus" })}
					>
						<ArrowPrev className="h-4 w-4" />
					</Button>
					<div>
						<h1 className="text-3xl font-bold">{menu.label}</h1>
						<p className="text-kumo-subtle">{t`Edit menu items`}</p>
					</div>
				</div>
				<div className="flex gap-2">
					<Button
						icon={<FileIcon />}
						variant="outline"
						onClick={() => setIsContentPickerOpen(true)}
					>
						{t`Add Content`}
					</Button>
					<Dialog.Root
						open={isAddOpen}
						onOpenChange={(open) => {
							setIsAddOpen(open);
							if (!open) setAddError(null);
						}}
					>
						<Dialog.Trigger
							render={(props) => (
								<Button {...props} icon={<Plus />}>
									{t`Add Custom Link`}
								</Button>
							)}
						/>
						<Dialog className="p-6" size="lg">
							<div className="flex items-start justify-between gap-4 mb-4">
								<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
									{t`Add Custom Link`}
								</Dialog.Title>
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
											<span className="sr-only">{t`Close`}</span>
										</Button>
									)}
								/>
							</div>
							<form onSubmit={handleAddCustomLink} className="space-y-4">
								<Input label={t`Label`} name="label" required placeholder={t`Home`} />
								<Input
									label={t`URL`}
									name="url"
									type="text"
									required
									pattern="(https?://.+|/.*)"
									title={t`Enter a URL (https://…) or a relative path (/…)`}
									placeholder={t`https://example.com or /about`}
								/>
								<Select
									label={t`Target`}
									name="target"
									defaultValue=""
									items={{ "": t`Same window`, _blank: t`New window` }}
								>
									<Select.Option value="">{t`Same window`}</Select.Option>
									<Select.Option value="_blank">{t`New window`}</Select.Option>
								</Select>
								<DialogError message={addError || getMutationError(createMutation.error)} />
								<div className="flex justify-end gap-2">
									<Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
										{t`Cancel`}
									</Button>
									<Button type="submit" disabled={createMutation.isPending}>
										{createMutation.isPending ? t`Adding...` : t`Add`}
									</Button>
								</div>
							</form>
						</Dialog>
					</Dialog.Root>
				</div>
			</div>

			<ContentPickerModal
				open={isContentPickerOpen}
				onOpenChange={setIsContentPickerOpen}
				onSelect={handleAddContent}
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
							variant="outline"
							onClick={() => setIsContentPickerOpen(true)}
						>
							{t`Add Content`}
						</Button>
						<Button icon={<Plus />} onClick={() => setIsAddOpen(true)}>
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
											<span className="inline-flex items-center rounded-full bg-kumo-brand/10 px-2 py-0.5 text-xs font-medium text-kumo-brand">
												{item.referenceCollection ?? item.type}
											</span>
										)}
										{item.target === "_blank" && t` (opens in new window)`}
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
									<Button variant="outline" size="sm" onClick={() => setEditingItem(item)}>
										{t`Edit`}
									</Button>
									<Button
										variant="outline"
										size="sm"
										aria-label={t`Delete`}
										onClick={() => deleteMutation.mutate(item.id)}
									>
										<Trash className="h-4 w-4" />
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			)}

			<Dialog.Root
				open={editingItem !== null}
				onOpenChange={(open: boolean) => {
					if (!open) {
						setEditingItem(null);
						setEditError(null);
					}
				}}
			>
				<Dialog className="p-6" size="lg">
					<div className="flex items-start justify-between gap-4 mb-4">
						<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
							{t`Edit Menu Item`}
						</Dialog.Title>
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
									<span className="sr-only">{t`Close`}</span>
								</Button>
							)}
						/>
					</div>
					{editingItem && (
						<form onSubmit={handleUpdateItem} className="space-y-4">
							<Input label={t`Label`} name="label" required defaultValue={editingItem.label} />
							{editingItem.type === "custom" && (
								<Input
									label={t`URL`}
									name="url"
									type="text"
									required
									pattern="(https?://.+|/.*)"
									title={t`Enter a URL (https://…) or a relative path (/…)`}
									defaultValue={editingItem.customUrl || ""}
								/>
							)}
							<Select
								label={t`Target`}
								name="target"
								defaultValue={editingItem.target || ""}
								items={{ "": t`Same window`, _blank: t`New window` }}
							>
								<Select.Option value="">{t`Same window`}</Select.Option>
								<Select.Option value="_blank">{t`New window`}</Select.Option>
							</Select>
							<Select
								label={t`Parent`}
								name="parentId"
								defaultValue={editingItem.parentId ?? ""}
								items={parentOptions}
							/>
							<DialogError message={editError || getMutationError(updateMutation.error)} />
							<div className="flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={() => setEditingItem(null)}>
									{t`Cancel`}
								</Button>
								<Button type="submit" disabled={updateMutation.isPending}>
									{updateMutation.isPending ? t`Saving...` : t`Save`}
								</Button>
							</div>
						</form>
					)}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
