import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	arrayMove,
	DndContext,
	closestCenter,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
	CSS,
} from "@dnd-kit/sortable";
import { GripVertical, X } from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "../lib/utils";

interface CollectionOrderItem {
	slug: string;
	label: string;
	sortOrder: number;
}

interface CollectionReorderDialogProps {
	open: boolean;
	onClose: () => void;
	collections: CollectionOrderItem[];
	onReorder: (collections: Array<{ slug: string; sortOrder: number }>) => Promise<void>;
}

function SortableCollectionRow({ item }: { item: CollectionOrderItem }) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: item.slug,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex items-center gap-2 px-3 py-2 rounded-md bg-kumo-base border",
				isDragging && "border-kumo-brand shadow-sm",
			)}
		>
			<button
				type="button"
				{...attributes}
				{...listeners}
				className="cursor-grab active:cursor-grabbing text-kumo-subtle hover:text-kumo-default p-1"
				aria-label="Drag to reorder"
			>
				<GripVertical className="size-4" />
			</button>
			<span className="flex-1 text-sm font-medium">{item.label}</span>
			<code className="text-xs text-kumo-subtle bg-kumo-tint px-1.5 py-0.5 rounded">{item.slug}</code>
		</div>
	);
}

/**
 * Dialog for reordering collections via drag-and-drop.
 */
export function CollectionReorderDialog({
	open,
	onClose,
	collections,
	onReorder,
}: CollectionReorderDialogProps) {
	const { t } = useLingui();
	const [order, setOrder] = React.useState<CollectionOrderItem[]>([]);
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		if (open) {
			setOrder([...collections].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)));
		}
	}, [open, collections]);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		setOrder((prev) => {
			const oldIndex = prev.findIndex((c) => c.slug === active.id);
			const newIndex = prev.findIndex((c) => c.slug === over.id);
			if (oldIndex === -1 || newIndex === -1) return prev;
			return arrayMove(prev, oldIndex, newIndex);
		});
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			await onReorder(order.map((c, i) => ({ slug: c.slug, sortOrder: i })));
			onClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(v) => !v && onClose()}>
			<Dialog.Content className="max-w-md">
				<Dialog.Header>
					<Dialog.Title>{t`Reorder Collections`}</Dialog.Title>
					<Dialog.CloseButton onClick={onClose}>
						<X className="size-4" />
					</Dialog.CloseButton>
				</Dialog.Header>

				<Dialog.Description>
					{t`Drag and drop to change the order of collections in the sidebar.`}
				</Dialog.Description>

				<div className="space-y-1 mt-4 max-h-80 overflow-y-auto">
					<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
						<SortableContext items={order.map((c) => c.slug)} strategy={verticalListSortingStrategy}>
							{order.map((item) => (
								<SortableCollectionRow key={item.slug} item={item} />
							))}
						</SortableContext>
					</DndContext>
				</div>

				<Dialog.Footer>
					<Button variant="secondary" onClick={onClose} disabled={saving}>
						{t`Cancel`}
					</Button>
					<Button variant="primary" onClick={handleSave} disabled={saving}>
						{saving ? t`Saving...` : t`Save Order`}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog>
	);
}
