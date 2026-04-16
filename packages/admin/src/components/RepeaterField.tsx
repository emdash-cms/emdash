/**
 * RepeaterField — renders a list of repeating sub-field groups in the content editor.
 *
 * Each item is a collapsible card containing the defined sub-fields.
 * Items can be added, removed, and reordered via drag-and-drop.
 */

import { Button, Input, InputArea } from "@cloudflare/kumo";
import { DndContext, closestCenter } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
	useSortable,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus, Trash, DotsSixVertical, CaretDown, CaretRight } from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "../lib/utils.js";

interface RepeaterSubFieldDef {
	slug: string;
	type: string;
	label: string;
	required?: boolean;
	options?: string[];
}

export interface RepeaterFieldProps {
	label: string;
	id: string;
	value: unknown;
	onChange: (value: unknown[]) => void;
	required?: boolean;
	subFields: RepeaterSubFieldDef[];
	minItems?: number;
	maxItems?: number;
}

type RepeaterItem = Record<string, unknown> & { _key: string };

function ensureKeys(items: unknown[]): RepeaterItem[] {
	return items.map((item, i) => {
		const obj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		return { ...obj, _key: (obj._key as string) || `item-${i}-${Date.now()}` };
	});
}

function stripKeys(items: RepeaterItem[]): Record<string, unknown>[] {
	return items.map(({ _key, ...rest }) => rest);
}

export function RepeaterField({
	label,
	id,
	value,
	onChange,
	subFields,
	minItems = 0,
	maxItems,
}: RepeaterFieldProps) {
	const { t } = useLingui();
	const rawItems = Array.isArray(value) ? value : [];
	const [items, setItems] = React.useState<RepeaterItem[]>(() => ensureKeys(rawItems));
	const [collapsedItems, setCollapsedItems] = React.useState<Set<string>>(new Set());

	// Sync from external value changes
	React.useEffect(() => {
		const incoming = Array.isArray(value) ? value : [];
		setItems(ensureKeys(incoming));
	}, [value]);

	const emitChange = (updated: RepeaterItem[]) => {
		setItems(updated);
		onChange(stripKeys(updated));
	};

	const handleAdd = () => {
		if (maxItems && items.length >= maxItems) return;
		const newItem: RepeaterItem = { _key: `item-${Date.now()}` };
		for (const sf of subFields) {
			newItem[sf.slug] =
				sf.type === "boolean" ? false : sf.type === "number" || sf.type === "integer" ? null : "";
		}
		emitChange([...items, newItem]);
	};

	const handleRemove = (key: string) => {
		if (items.length <= minItems) return;
		emitChange(items.filter((item) => item._key !== key));
	};

	const handleItemChange = (key: string, fieldSlug: string, fieldValue: unknown) => {
		emitChange(
			items.map((item) => (item._key === key ? { ...item, [fieldSlug]: fieldValue } : item)),
		);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const oldIndex = items.findIndex((item) => item._key === active.id);
		const newIndex = items.findIndex((item) => item._key === over.id);
		if (oldIndex === -1 || newIndex === -1) return;
		emitChange(arrayMove(items, oldIndex, newIndex));
	};

	const toggleCollapse = (key: string) => {
		setCollapsedItems((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const canAdd = !maxItems || items.length < maxItems;
	const canRemove = items.length > minItems;

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label htmlFor={id} className="text-sm font-medium">
					{label}
					{items.length > 0 && (
						<span className="ms-2 text-kumo-subtle font-normal">
							{plural(items.length, { one: "(# item)", other: "(# items)" })}
						</span>
					)}
				</label>
				{canAdd && (
					<Button variant="outline" size="sm" icon={<Plus />} onClick={handleAdd}>
						{t`Add Item`}
					</Button>
				)}
			</div>

			{items.length === 0 ? (
				<div className="border-2 border-dashed rounded-lg p-6 text-center text-kumo-subtle">
					<p className="text-sm">{t`No items yet`}</p>
					{canAdd && (
						<Button
							variant="outline"
							size="sm"
							className="mt-2"
							icon={<Plus />}
							onClick={handleAdd}
						>
							{t`Add First Item`}
						</Button>
					)}
				</div>
			) : (
				<DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext
						items={items.map((item) => item._key)}
						strategy={verticalListSortingStrategy}
					>
						<div className="space-y-2">
							{items.map((item, index) => (
								<SortableRepeaterItem
									key={item._key}
									item={item}
									index={index}
									subFields={subFields}
									isCollapsed={collapsedItems.has(item._key)}
									onToggleCollapse={() => toggleCollapse(item._key)}
									onRemove={canRemove ? () => handleRemove(item._key) : undefined}
									onChange={(fieldSlug, fieldValue) =>
										handleItemChange(item._key, fieldSlug, fieldValue)
									}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
			)}
		</div>
	);
}

interface SortableRepeaterItemProps {
	item: RepeaterItem;
	index: number;
	subFields: RepeaterSubFieldDef[];
	isCollapsed: boolean;
	onToggleCollapse: () => void;
	onRemove?: () => void;
	onChange: (fieldSlug: string, value: unknown) => void;
}

function SortableRepeaterItem({
	item,
	index,
	subFields,
	isCollapsed,
	onToggleCollapse,
	onRemove,
	onChange,
}: SortableRepeaterItemProps) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: item._key,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	// Use the first text sub-field as the item summary label
	const summaryField = subFields.find((sf) => sf.type === "string" || sf.type === "text");
	const summaryValue = summaryField ? (item[summaryField.slug] as string) || "" : "";
	const summaryLabel = summaryValue || t`Item ${index + 1}`;

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"border rounded-lg bg-kumo-base",
				isDragging && "opacity-50 ring-2 ring-kumo-brand",
			)}
		>
			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 py-2 border-b cursor-pointer"
				onClick={onToggleCollapse}
			>
				<DotsSixVertical
					className="h-4 w-4 text-kumo-subtle cursor-grab shrink-0"
					{...attributes}
					{...listeners}
					onClick={(e) => e.stopPropagation()}
				/>
				{isCollapsed ? (
					<CaretRight className="h-4 w-4 text-kumo-subtle shrink-0" />
				) : (
					<CaretDown className="h-4 w-4 text-kumo-subtle shrink-0" />
				)}
				<span className="text-sm font-medium flex-1 truncate">{summaryLabel}</span>
				{onRemove && (
					<Button
						variant="ghost"
						shape="square"
						onClick={(e) => {
							e.stopPropagation();
							onRemove();
						}}
						aria-label={t`Remove item ${index + 1}`}
					>
						<Trash className="h-3.5 w-3.5 text-kumo-danger" />
					</Button>
				)}
			</div>

			{/* Sub-fields */}
			{!isCollapsed && (
				<div className="p-3 space-y-3">
					{subFields.map((sf) => (
						<SubFieldInput
							key={sf.slug}
							subField={sf}
							value={item[sf.slug]}
							onChange={(v) => onChange(sf.slug, v)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

interface SubFieldInputProps {
	subField: RepeaterSubFieldDef;
	value: unknown;
	onChange: (value: unknown) => void;
}

function SubFieldInput({ subField, value, onChange }: SubFieldInputProps) {
	const { t } = useLingui();
	switch (subField.type) {
		case "string":
			return (
				<Input
					label={subField.label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
					required={subField.required}
				/>
			);
		case "text":
			return (
				<InputArea
					label={subField.label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
					required={subField.required}
					rows={3}
				/>
			);
		case "number":
		case "integer":
			return (
				<Input
					label={subField.label}
					type="number"
					value={typeof value === "number" ? String(value) : ""}
					onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
					required={subField.required}
					step={subField.type === "integer" ? "1" : "any"}
				/>
			);
		case "boolean":
			return (
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={Boolean(value)}
						onChange={(e) => onChange(e.target.checked)}
					/>
					<span className="text-sm">{subField.label}</span>
				</label>
			);
		case "datetime":
			return (
				<Input
					label={subField.label}
					type="datetime-local"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
					required={subField.required}
				/>
			);
		case "select":
			return (
				<div>
					<label className="text-sm font-medium">{subField.label}</label>
					<select
						className="w-full mt-1 rounded-md border px-3 py-2 text-sm"
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(e.target.value)}
						required={subField.required}
					>
						<option value="">{t`Select...`}</option>
						{subField.options?.map((opt) => (
							<option key={opt} value={opt}>
								{opt}
							</option>
						))}
					</select>
				</div>
			);
		default:
			return (
				<Input
					label={subField.label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
	}
}
