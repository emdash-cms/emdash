import { Badge, Button, Input, Label } from "@cloudflare/kumo";
import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	type DragEndEvent,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, CaretRight, Copy, DotsSixVertical, Plus, Trash } from "@phosphor-icons/react";
import * as React from "react";

import type { BlockFieldDefinition, BlockType } from "../lib/api/schema.js";
import {
	createBlockKey,
	createBlockValue,
	duplicateBlockValue,
	isStoredBlockValue,
	moveBlockValue,
	type StoredBlockValue,
	updateBlockFieldValue,
} from "../lib/block-field-state.js";
import { cn } from "../lib/utils.js";

interface NestedFieldDescriptor {
	id?: string;
	kind: string;
	label?: string;
	required?: boolean;
	options?: Array<{ value: string; label: string }> | Record<string, unknown>;
	validation?: Record<string, unknown>;
}

interface NestedFieldRenderInput {
	name: string;
	field: NestedFieldDescriptor;
	value: unknown;
	onChange: (value: unknown) => void;
}

export interface BlocksFieldProps {
	id: string;
	fieldPath: string;
	label: string;
	value: unknown;
	onChange: (value: StoredBlockValue[]) => void;
	blockTypes: readonly BlockType[];
	allowedTypes: readonly string[];
	retiredTypes: readonly string[];
	minItems?: number;
	maxItems?: number;
	readOnly?: boolean;
	renderField: (input: NestedFieldRenderInput) => React.ReactNode;
}

const NESTED_KIND: Record<string, string> = {
	string: "string",
	text: "richText",
	url: "url",
	number: "number",
	integer: "number",
	boolean: "boolean",
	datetime: "datetime",
	select: "select",
	multiSelect: "multiSelect",
	portableText: "portableText",
	image: "image",
	file: "file",
	repeater: "repeater",
};

function nestedDescriptor(
	outerId: string,
	blockKey: string,
	field: BlockFieldDefinition,
): NestedFieldDescriptor {
	const options = Array.isArray(field.validation?.options)
		? field.validation.options
				.filter((option): option is string => typeof option === "string")
				.map((option) => ({ value: option, label: option }))
		: field.options;
	return {
		id: `${outerId}:${blockKey}:${field.slug}`,
		kind: NESTED_KIND[field.type] ?? "unsupported",
		label: field.label,
		required: field.required,
		validation: field.validation,
		options,
	};
}

function summary(block: StoredBlockValue, fields: readonly BlockFieldDefinition[]): string | null {
	for (const field of fields) {
		const value = block[field.slug];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

export function BlocksField({
	id,
	fieldPath,
	label,
	value,
	onChange,
	blockTypes,
	allowedTypes,
	retiredTypes,
	minItems = 0,
	maxItems = 100,
	readOnly = false,
	renderField,
}: BlocksFieldProps) {
	const { t } = useLingui();
	const blocks = Array.isArray(value) ? value.filter(isStoredBlockValue) : [];
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [query, setQuery] = React.useState("");
	const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
	const typeBySlug = React.useMemo(
		() => new Map(blockTypes.map((blockType) => [blockType.slug, blockType])),
		[blockTypes],
	);
	const allowed = allowedTypes
		.map((slug) => typeBySlug.get(slug))
		.filter((blockType): blockType is BlockType => blockType !== undefined)
		.filter((blockType) => {
			const needle = query.trim().toLocaleLowerCase();
			return (
				!needle ||
				blockType.label.toLocaleLowerCase().includes(needle) ||
				blockType.slug.toLocaleLowerCase().includes(needle) ||
				blockType.category?.toLocaleLowerCase().includes(needle)
			);
		});
	const grouped = new Map<string, BlockType[]>();
	for (const blockType of allowed) {
		const category = blockType.category || t`Other`;
		grouped.set(category, [...(grouped.get(category) ?? []), blockType]);
	}
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		if (!event.over || event.active.id === event.over.id) return;
		const from = blocks.findIndex((block) => block._key === event.active.id);
		const to = blocks.findIndex((block) => block._key === event.over?.id);
		onChange(moveBlockValue(blocks, from, to));
	};

	return (
		<div id={id} className="grid gap-3">
			<div className="flex items-center justify-between gap-3">
				<Label>{label}</Label>
				{!readOnly && (
					<Button
						variant="outline"
						size="sm"
						icon={<Plus />}
						disabled={blocks.length >= maxItems || allowed.length === 0}
						onClick={() => setPickerOpen((open) => !open)}
					>
						{t`Add block`}
					</Button>
				)}
			</div>

			{pickerOpen && !readOnly && (
				<div className="rounded-lg border border-kumo-line bg-kumo-control p-3 space-y-3">
					<Input
						aria-label={t`Search block types`}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t`Search blocks`}
					/>
					<div className="max-h-64 overflow-y-auto space-y-3">
						{Array.from(grouped, ([category, types]) => (
							<div key={category}>
								<p className="mb-1 text-xs font-medium text-kumo-subtle">{category}</p>
								<div className="grid gap-1 sm:grid-cols-2">
									{types.map((blockType) => (
										<Button
											key={blockType.slug}
											variant="ghost"
											className="h-auto justify-start text-start"
											onClick={() => {
												onChange([...blocks, createBlockValue(blockType, createBlockKey())]);
												setPickerOpen(false);
												setQuery("");
											}}
										>
											<span>
												<span className="block font-medium">{blockType.label}</span>
												{blockType.description && (
													<span className="block text-xs text-kumo-subtle">
														{blockType.description}
													</span>
												)}
											</span>
										</Button>
									))}
								</div>
							</div>
						))}
						{allowed.length === 0 && (
							<p className="py-4 text-center text-sm text-kumo-subtle">
								{t`No matching block types`}
							</p>
						)}
					</div>
				</div>
			)}

			{blocks.length === 0 ? (
				<p className="rounded-lg border border-dashed border-kumo-line p-6 text-center text-sm text-kumo-subtle">
					{t`No blocks yet`}
				</p>
			) : (
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext
						items={blocks.map((block) => block._key)}
						strategy={verticalListSortingStrategy}
					>
						<div className="space-y-3">
							{blocks.map((block, index) => (
								<BlockCard
									key={block._key}
									outerId={id}
									fieldPath={fieldPath}
									block={block}
									index={index}
									blockType={typeBySlug.get(block._type)}
									retired={retiredTypes.includes(block._type)}
									collapsed={collapsed.has(block._key)}
									readOnly={readOnly}
									onToggle={() =>
										setCollapsed((current) => {
											const next = new Set(current);
											if (next.has(block._key)) next.delete(block._key);
											else next.add(block._key);
											return next;
										})
									}
									onChange={(field, nextValue) =>
										onChange(updateBlockFieldValue(blocks, block._key, field, nextValue))
									}
									onDuplicate={() => {
										const next = [...blocks];
										next.splice(index + 1, 0, duplicateBlockValue(block, createBlockKey()));
										onChange(next);
									}}
									onDelete={() => onChange(blocks.filter((item) => item._key !== block._key))}
									renderField={renderField}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
			)}

			{blocks.length < minItems && (
				<p className="text-sm text-kumo-danger">{t`Add at least ${minItems} blocks.`}</p>
			)}
		</div>
	);
}

interface BlockCardProps {
	outerId: string;
	fieldPath: string;
	block: StoredBlockValue;
	index: number;
	blockType?: BlockType;
	retired: boolean;
	collapsed: boolean;
	readOnly: boolean;
	onToggle: () => void;
	onChange: (field: string, value: unknown) => void;
	onDuplicate: () => void;
	onDelete: () => void;
	renderField: BlocksFieldProps["renderField"];
}

function BlockCard({
	outerId,
	fieldPath,
	block,
	index,
	blockType,
	retired,
	collapsed,
	readOnly,
	onToggle,
	onChange,
	onDuplicate,
	onDelete,
	renderField,
}: BlockCardProps) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: block._key,
		disabled: readOnly,
	});
	const style = { transform: CSS.Transform.toString(transform), transition };
	const version = blockType?.versions.find((candidate) => candidate.version === block._version);
	const unsupported = !blockType || !version || Boolean(version.unsupportedTypes?.length);
	const inactive = Boolean(blockType && block._version !== blockType.currentVersion);
	const blockSummary = version ? summary(block, version.fields) : null;

	return (
		<section
			ref={setNodeRef}
			style={style}
			className={cn(
				"rounded-lg border border-kumo-line bg-kumo-control",
				isDragging && "opacity-50",
			)}
			data-block-key={block._key}
		>
			<div className="flex items-center gap-2 p-3">
				{!readOnly && (
					<button
						{...attributes}
						{...listeners}
						type="button"
						className="cursor-grab touch-none active:cursor-grabbing"
						aria-label={t`Reorder ${blockType?.label ?? block._type}`}
					>
						<DotsSixVertical className="h-5 w-5 text-kumo-subtle" />
					</button>
				)}
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					onClick={onToggle}
					aria-label={collapsed ? t`Expand block` : t`Collapse block`}
				>
					{collapsed ? (
						<CaretRight className="h-4 w-4 rtl:-scale-x-100" />
					) : (
						<CaretDown className="h-4 w-4" />
					)}
				</Button>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{blockType?.label ?? block._type}</span>
						<Badge variant="secondary">{t`Version ${block._version}`}</Badge>
						{inactive && <Badge variant="secondary">{t`Inactive version`}</Badge>}
						{retired && <Badge variant="secondary">{t`Retired`}</Badge>}
						{unsupported && <Badge variant="secondary">{t`Unsupported`}</Badge>}
					</div>
					{blockSummary && <p className="truncate text-xs text-kumo-subtle">{blockSummary}</p>}
				</div>
				{!readOnly && (
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							disabled={retired || unsupported}
							onClick={onDuplicate}
							aria-label={t`Duplicate block`}
						>
							<Copy className="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							onClick={onDelete}
							aria-label={t`Delete block`}
						>
							<Trash className="h-4 w-4 text-kumo-danger" />
						</Button>
					</div>
				)}
			</div>

			{!collapsed && (
				<div className="space-y-4 border-t border-kumo-line p-4">
					{unsupported ? (
						<p className="text-sm text-kumo-subtle">
							{t`This block cannot be edited because its stored definition is unavailable.`}
						</p>
					) : (
						version?.fields.map((field) =>
							renderField({
								name: `${fieldPath}.${block._key}.${field.slug}`,
								field: nestedDescriptor(outerId, block._key, field),
								value: block[field.slug],
								onChange: (nextValue) => onChange(field.slug, nextValue),
							}),
						)
					)}
					<span className="sr-only">{t`Block ${index + 1}`}</span>
				</div>
			)}
		</section>
	);
}
