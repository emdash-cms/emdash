/**
 * RepeaterField — renders a list of repeating sub-field groups in the content editor.
 *
 * Each item is a collapsible card containing the defined sub-fields.
 * Items can be added, removed, and reordered via drag-and-drop.
 */

import { Button, Combobox, Input, InputArea, Switch } from "@cloudflare/kumo";
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
import { Plus, Trash, DotsSixVertical, CaretDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchTerms, type TaxonomyTerm } from "../lib/api";
import { fromDatetimeLocalInputValue, toDatetimeLocalInputValue } from "../lib/datetime-local.js";
import { cn } from "../lib/utils.js";
import { CaretNext } from "./ArrowIcons.js";
import { ImageFieldRenderer, type ImageFieldValue } from "./ImageFieldRenderer.js";

/**
 * Sentinel used in a `select` sub-field's `options` to bind its choices to a
 * taxonomy's live terms instead of a static list, e.g. `["@taxonomy:tag"]`.
 */
const TAXONOMY_OPTION_PREFIX = "@taxonomy:";

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
	/**
	 * Content locale of the entry being edited. Scopes taxonomy-backed select
	 * sub-fields to the entry's locale so multi-locale installs don't mix
	 * translation variants in one dropdown.
	 */
	locale?: string | null;
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
	locale,
}: RepeaterFieldProps) {
	const { t } = useLingui();
	const rawItems = Array.isArray(value) ? value : [];
	const [items, setItems] = React.useState<RepeaterItem[]>(() => ensureKeys(rawItems));
	const [collapsedItems, setCollapsedItems] = React.useState<Set<string>>(new Set());

	// Sync from external value changes.
	// Preserve each item's _key by position so round-trips through onChange
	// (which strips _key) don't remount children on every keystroke.
	React.useEffect(() => {
		const incoming = Array.isArray(value) ? value : [];
		setItems((prev) =>
			incoming.map((item, i) => {
				const obj = (typeof item === "object" && item !== null ? item : {}) as Record<
					string,
					unknown
				>;
				const existingKey = (obj._key as string) || prev[i]?._key;
				return {
					...obj,
					_key: existingKey || `item-${i}-${Date.now()}`,
				};
			}),
		);
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
				sf.type === "boolean"
					? false
					: sf.type === "number" || sf.type === "integer" || sf.type === "image"
						? null
						: "";
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
									locale={locale}
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
	locale?: string | null;
}

function SortableRepeaterItem({
	item,
	index,
	subFields,
	isCollapsed,
	onToggleCollapse,
	onRemove,
	onChange,
	locale,
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
					<CaretNext className="h-4 w-4 text-kumo-subtle shrink-0" />
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
							locale={locale}
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
	locale?: string | null;
}

/**
 * A `select` sub-field whose choices are the live terms of a taxonomy. Used
 * when the sub-field's `options` is the `@taxonomy:<name>` sentinel, so
 * repeater rows can pick from a managed vocabulary that stays in sync as terms
 * are added — no need to duplicate the term list in the collection schema.
 */
function TaxonomySubFieldCombobox({
	taxonomyName,
	label,
	value,
	onChange,
	required,
	locale,
}: {
	taxonomyName: string;
	label: string;
	value: unknown;
	onChange: (value: unknown) => void;
	required?: boolean;
	locale?: string | null;
}) {
	const { t } = useLingui();
	// Shares the ["taxonomy-terms", name, locale] cache with TaxonomyManager /
	// TaxonomySidebar, so term creates/updates elsewhere in the admin
	// invalidate this dropdown too instead of it lagging a stale window behind.
	const { data: terms = [] } = useQuery<TaxonomyTerm[]>({
		queryKey: ["taxonomy-terms", taxonomyName, locale ?? undefined],
		queryFn: () => fetchTerms(taxonomyName, { locale: locale ?? undefined }),
		staleTime: 30_000,
	});
	const options = terms.map((term) => term.label);
	return (
		<Combobox
			label={label}
			value={typeof value === "string" && value ? value : null}
			onValueChange={(v) => onChange(typeof v === "string" ? v : "")}
			items={options}
			required={required}
		>
			<Combobox.TriggerInput placeholder={t`Select...`} />
			<Combobox.Content>
				<Combobox.Empty>{t`No results`}</Combobox.Empty>
				<Combobox.List>
					{(opt: string) => (
						<Combobox.Item key={opt} value={opt}>
							{opt}
						</Combobox.Item>
					)}
				</Combobox.List>
			</Combobox.Content>
		</Combobox>
	);
}

function SubFieldInput({ subField, value, onChange, locale }: SubFieldInputProps) {
	const { t } = useLingui();
	switch (subField.type) {
		case "string":
			return (
				<Input
					label={subField.label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
					required={subField.required}
					dir="auto"
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
					dir="auto"
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
				<Switch
					checked={Boolean(value)}
					onCheckedChange={(checked) => onChange(checked)}
					label={<span className="text-sm">{subField.label}</span>}
				/>
			);
		case "datetime":
			return (
				<Input
					label={subField.label}
					type="datetime-local"
					value={toDatetimeLocalInputValue(value)}
					onChange={(e) => onChange(fromDatetimeLocalInputValue(e.target.value))}
					required={subField.required}
				/>
			);
		case "select": {
			// Searchable combobox so long option lists (e.g. taxonomy-derived
			// options) stay usable inside repeater rows, rather than a plain
			// scrolling select.
			const options = Array.isArray(subField.options) ? subField.options : [];
			// A leading `@taxonomy:<name>` sentinel binds the choices to a live
			// taxonomy's terms instead of the static option list.
			const taxonomyName =
				typeof options[0] === "string" && options[0].startsWith(TAXONOMY_OPTION_PREFIX)
					? options[0].slice(TAXONOMY_OPTION_PREFIX.length)
					: null;
			if (taxonomyName) {
				return (
					<TaxonomySubFieldCombobox
						taxonomyName={taxonomyName}
						label={subField.label}
						value={value}
						onChange={onChange}
						required={subField.required}
						locale={locale}
					/>
				);
			}
			return (
				<Combobox
					label={subField.label}
					value={typeof value === "string" && value ? value : null}
					onValueChange={(v) => onChange(typeof v === "string" ? v : "")}
					items={options}
					required={subField.required}
				>
					<Combobox.TriggerInput placeholder={t`Select...`} />
					<Combobox.Content>
						<Combobox.Empty>{t`No results`}</Combobox.Empty>
						<Combobox.List>
							{(opt: string) => (
								<Combobox.Item key={opt} value={opt}>
									{opt}
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Content>
				</Combobox>
			);
		}
		case "image":
			return (
				<ImageFieldRenderer
					label={subField.label}
					// Same backwards-compat contract as top-level image fields:
					// objects are MediaValues, strings are legacy URLs.
					value={
						value != null && typeof value === "object"
							? (value as ImageFieldValue)
							: typeof value === "string" && value
								? value
								: undefined
					}
					onChange={(v) => onChange(v)}
					required={subField.required}
				/>
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
