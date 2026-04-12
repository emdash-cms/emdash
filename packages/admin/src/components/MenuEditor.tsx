/**
 * Menu Editor component
 *
 * Edit menu items with basic reordering (simplified version without drag-and-drop)
 */

import { Button, Dialog, Input, Select, Toast } from "@cloudflare/kumo";
import {
	Plus,
	Trash,
	CaretUp,
	CaretDown,
	Link as LinkIcon,
	ArrowLeft,
	X,
	File as FileIcon,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchMenu,
	createMenuItem,
	deleteMenuItem,
	updateMenuItem,
	reorderMenuItems,
	type MenuItem,
} from "../lib/api";
import { ContentPickerModal } from "./ContentPickerModal";
import { DialogError, getMutationError } from "./DialogError.js";

export function MenuEditor() {
	const { name } = useParams({ from: "/_admin/menus/$name" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isAddOpen, setIsAddOpen] = React.useState(false);
	const [isContentPickerOpen, setIsContentPickerOpen] = React.useState(false);
	const [editingItem, setEditingItem] = React.useState<MenuItem | null>(null);
	const [localItems, setLocalItems] = React.useState<MenuItem[]>([]);
	const [addError, setAddError] = React.useState<string | null>(null);
	const [editError, setEditError] = React.useState<string | null>(null);

	const { data: menu, isLoading } = useQuery({
		queryKey: ["menu", name],
		queryFn: () => fetchMenu(name),
		staleTime: Infinity,
	});

	// Sync local items with fetched data
	React.useEffect(() => {
		if (menu?.items) {
			setLocalItems(menu.items);
		}
	}, [menu]);

	const createMutation = useMutation({
		mutationFn: (input: Parameters<typeof createMenuItem>[1]) => createMenuItem(name, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			setIsAddOpen(false);
			toastManager.add({ title: "Item added", description: "Menu item has been added." });
		},
		onError: (error: Error) => {
			setAddError(error.message);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (itemId: string) => deleteMenuItem(name, itemId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			toastManager.add({
				title: "Item deleted",
				description: "Menu item has been deleted.",
			});
		},
		onError: (error: Error) => {
			toastManager.add({
				title: "Error",
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
		}) => updateMenuItem(name, itemId, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			setEditingItem(null);
			toastManager.add({
				title: "Item updated",
				description: "Menu item has been updated.",
			});
		},
		onError: (error: Error) => {
			setEditError(error.message);
		},
	});

	const reorderMutation = useMutation({
		mutationFn: (input: Parameters<typeof reorderMenuItems>[1]) => reorderMenuItems(name, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["menu", name] });
			toastManager.add({
				title: "Order saved",
				description: "Menu order has been updated.",
			});
		},
		onError: (error: Error) => {
			toastManager.add({
				title: "Error",
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
		createMutation.mutate({
			type: item.collection,
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
		updateMutation.mutate({
			itemId: editingItem.id,
			input: {
				label: typeof uLabelVal === "string" ? uLabelVal : "",
				customUrl:
					editingItem.type === "custom" ? (typeof uUrlVal === "string" ? uUrlVal : "") : undefined,
				target: (typeof uTargetVal === "string" ? uTargetVal : "") || undefined,
			},
		});
	};

	const moveItem = (index: number, direction: "up" | "down") => {
		const newItems = [...localItems];
		const targetIndex = direction === "up" ? index - 1 : index + 1;
		if (targetIndex < 0 || targetIndex >= newItems.length) return;

		const currentItem = newItems[index];
		const targetItem = newItems[targetIndex];
		if (!currentItem || !targetItem) return;

		newItems[index] = targetItem;
		newItems[targetIndex] = currentItem;

		// Update sort orders
		const reorderedItems = newItems.map((item, i) => ({
			id: item.id,
			parentId: item.parent_id,
			sortOrder: i,
		}));

		setLocalItems(newItems);
		reorderMutation.mutate({ items: reorderedItems });
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-kumo-subtle">Loading menu...</div>
			</div>
		);
	}

	if (!menu) {
		return (
			<div className="text-center py-12">
				<p className="text-kumo-subtle">Menu not found</p>
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
						aria-label="Back"
						onClick={() => navigate({ to: "/menus" })}
					>
						<ArrowLeft className="h-4 w-4" />
					</Button>
					<div>
						<h1 className="text-3xl font-bold">{menu.label}</h1>
						<p className="text-kumo-subtle">Edit menu items</p>
					</div>
				</div>
				<div className="flex gap-2">
					<Button
						icon={<FileIcon />}
						variant="outline"
						onClick={() => setIsContentPickerOpen(true)}
					>
						Add Content
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
									Add Custom Link
								</Button>
							)}
						/>
						<Dialog className="p-6" size="lg">
							<div className="flex items-start justify-between gap-4 mb-4">
								<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
									Add Custom Link
								</Dialog.Title>
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
											<span className="sr-only">Close</span>
										</Button>
									)}
								/>
							</div>
							<form onSubmit={handleAddCustomLink} className="space-y-4">
								<Input label="Label" name="label" required placeholder="Home" />
								<Input
									label="URL"
									name="url"
									type="text"
									required
									pattern="(https?://.+|/.*)"
									title="Enter a URL (https://…) or a relative path (/…)"
									placeholder="https://example.com or /about"
								/>
								<Select
									label="Target"
									name="target"
									defaultValue=""
									items={{ "": "Same window", _blank: "New window" }}
								>
									<Select.Option value="">Same window</Select.Option>
									<Select.Option value="_blank">New window</Select.Option>
								</Select>
								<DialogError message={addError || getMutationError(createMutation.error)} />
								<div className="flex justify-end gap-2">
									<Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
										Cancel
									</Button>
									<Button type="submit" disabled={createMutation.isPending}>
										{createMutation.isPending ? "Adding..." : "Add"}
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

			{localItems.length === 0 ? (
				<div className="border rounded-lg p-12 text-center">
					<LinkIcon className="mx-auto h-12 w-12 text-kumo-subtle mb-4" />
					<h3 className="text-lg font-semibold mb-2">No menu items yet</h3>
					<p className="text-kumo-subtle mb-4">Add links to build your navigation menu</p>
					<div className="flex justify-center gap-2">
						<Button
							icon={<FileIcon />}
							variant="outline"
							onClick={() => setIsContentPickerOpen(true)}
						>
							Add Content
						</Button>
						<Button icon={<Plus />} onClick={() => setIsAddOpen(true)}>
							Add Custom Link
						</Button>
					</div>
				</div>
			) : (
				<div className="space-y-2">
					{localItems.map((item, index) => (
						<div key={item.id} className="border rounded-lg p-4 flex items-center justify-between">
							<div className="flex-1">
								<div className="font-medium">{item.label}</div>
								<div className="text-sm text-kumo-subtle">
									{item.type === "custom" ? (
										item.custom_url
									) : (
										<span className="inline-flex items-center rounded-full bg-kumo-brand/10 px-2 py-0.5 text-xs font-medium text-kumo-brand">
											{item.reference_collection ?? item.type}
										</span>
									)}
									{item.target === "_blank" && " (opens in new window)"}
								</div>
							</div>
							<div className="flex gap-2">
								<Button
									variant="ghost"
									size="sm"
									aria-label="Move up"
									onClick={() => moveItem(index, "up")}
									disabled={index === 0}
								>
									<CaretUp className="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="sm"
									aria-label="Move down"
									onClick={() => moveItem(index, "down")}
									disabled={index === localItems.length - 1}
								>
									<CaretDown className="h-4 w-4" />
								</Button>
								<Button variant="outline" size="sm" onClick={() => setEditingItem(item)}>
									Edit
								</Button>
								<Button
									variant="outline"
									size="sm"
									aria-label="Delete"
									onClick={() => deleteMutation.mutate(item.id)}
								>
									<Trash className="h-4 w-4" />
								</Button>
							</div>
						</div>
					))}
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
							Edit Menu Item
						</Dialog.Title>
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
									<span className="sr-only">Close</span>
								</Button>
							)}
						/>
					</div>
					{editingItem && (
						<form onSubmit={handleUpdateItem} className="space-y-4">
							<Input label="Label" name="label" required defaultValue={editingItem.label} />
							{editingItem.type === "custom" && (
								<Input
									label="URL"
									name="url"
									type="text"
									required
									pattern="(https?://.+|/.*)"
									title="Enter a URL (https://…) or a relative path (/…)"
									defaultValue={editingItem.custom_url || ""}
								/>
							)}
							<Select
								label="Target"
								name="target"
								defaultValue={editingItem.target || ""}
								items={{ "": "Same window", _blank: "New window" }}
							>
								<Select.Option value="">Same window</Select.Option>
								<Select.Option value="_blank">New window</Select.Option>
							</Select>
							<DialogError message={editError || getMutationError(updateMutation.error)} />
							<div className="flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={() => setEditingItem(null)}>
									Cancel
								</Button>
								<Button type="submit" disabled={updateMutation.isPending}>
									{updateMutation.isPending ? "Saving..." : "Save"}
								</Button>
							</div>
						</form>
					)}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
