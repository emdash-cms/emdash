import { Badge, Button, DropdownMenu, Label, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	closestCenter,
	DndContext,
	PointerSensor,
	type DragEndEvent,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowsInSimple,
	ArrowsOutSimple,
	ArrowUp,
	CaretRight,
	Copy,
	DotsSixVertical,
	DotsThree,
	Plus,
	RowsPlusBottom,
	RowsPlusTop,
	SlidersHorizontal,
	Trash,
} from "@phosphor-icons/react";
import * as React from "react";

import type { BlockFieldDefinition, BlockType } from "../lib/api/schema.js";
import {
	blockSummary,
	type BlockFieldPart,
	type ListSubField,
	planBlockFields,
	repeaterSubFields,
	splitLabelHint,
} from "../lib/block-field-layout.js";
import {
	createBlockKey,
	createBlockValue,
	duplicateBlockValue,
	insertBlockValue,
	isStoredBlockValue,
	moveBlockValue,
	type StoredBlockValue,
	updateBlockFieldValue,
} from "../lib/block-field-state.js";
import { type BlockValueIssue, validateBlocks } from "../lib/block-validation.js";
import { useStableCallback } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import {
	BlockListField,
	type DeletedListItem,
	ErrorDot,
	FOCUSABLE,
	firstPhotoUrl,
	focusableIn,
	toggled,
} from "./BlockListField.js";
import { BlockTypeIcon, BlockTypePicker } from "./BlockTypePicker.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

interface NestedFieldDescriptor {
	id?: string;
	kind: string;
	label?: string;
	required?: boolean;
	options?: Array<{ value: string; label: string }> | Record<string, unknown>;
	validation?: Record<string, unknown>;
	blockType?: string;
	blockVersion?: number;
	/** Set on `integer` fields, which share the `number` kind. */
	integer?: boolean;
}

/** How a block draws a nested field's control: the block draws the label, hint and errors. */
export interface FieldChrome {
	/** Id of the element that names the control. */
	labelledBy: string;
	describedBy?: string;
	placeholder?: string;
	invalid?: boolean;
	/** The block's headline, drawn larger. */
	heading?: boolean;
	/** Draws a photo as a thumbnail: in a list item's settings row, or in a table cell. */
	thumbnail?: "row" | "cell";
}

/** A block field, or a list's sub-field, as an open block lays it out. */
type LayoutFieldDefinition = Pick<
	BlockFieldDefinition,
	"slug" | "label" | "required" | "validation" | "options"
> & { type: string };

interface NestedFieldRenderInput {
	name: string;
	field: NestedFieldDescriptor;
	value: unknown;
	onChange: (value: unknown) => void;
	chrome: FieldChrome;
}

export interface BlocksFieldProps {
	id: string;
	fieldId?: string;
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
	/**
	 * A new token shows every problem in the field's blocks, opens the block that holds
	 * the control with id `focusId`, and focuses it.
	 */
	reveal?: BlockReveal;
}

export interface BlockReveal {
	token: number;
	focusId?: string;
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
};

const UNDO_TIMEOUT_MS = 6000;
const SHEET_INNER_TOP = "rounded-t-[calc(var(--radius-lg)-1px)]";
const SHEET_INNER_BOTTOM = "rounded-b-[calc(var(--radius-lg)-1px)]";
const MENU_ICON = "size-4";
const FIELD_LABEL = "ps-2 text-xs leading-4 font-medium text-kumo-subtle wrap-anywhere";
const SETTING_ROW =
	"grid min-w-0 items-start gap-x-2 @min-[440px]/blocks:grid-cols-[11rem_minmax(0,1fr)]";
const SETTING_LABEL =
	"flex items-center ps-2 pt-2 pb-0.5 text-sm text-kumo-subtle wrap-anywhere @min-[440px]/blocks:min-h-8 @min-[440px]/blocks:py-1";

type InsertSide = "top" | "bottom";

interface PickerTarget {
	index: number;
	anchor: Element | null;
	side: InsertSide;
	invoker: HTMLElement | null;
}

type FocusRequest =
	| { key: string; target: "first-control" | "toggle" }
	| { key: string; target: "field"; elementId: string; field: string }
	| { key: string; target: "item"; field: string; index: number }
	| { target: "add" };

type UndoOwner = { kind: "block" } | { kind: "item"; blockKey: string; field: string };

interface ItemReveal {
	blockKey: string;
	field: string;
	index: number;
	token: number;
}

const NO_ISSUES: readonly BlockValueIssue[] = [];

/** Field types whose empty control says "Required" itself: in red placeholder text, or a red photo slot. */
const REQUIRED_SHOWN_BY_CONTROL = new Set([
	"string",
	"text",
	"url",
	"number",
	"integer",
	"select",
	"image",
]);

function touchKey(blockKey: string, field: string): string {
	return `${blockKey}:${field}`;
}

function useIssueMessage() {
	const { t, i18n } = useLingui();
	return React.useCallback(
		(issue: BlockValueIssue, hint?: string): string => {
			switch (issue.code) {
				case "required":
					return t`Required`;
				case "invalid_format":
					if (hint) return hint;
					return issue.format === "url"
						? t`Enter a valid URL (e.g. https://example.com)`
						: t`Check the format`;
				case "invalid_value":
					return t`Choose one of the options`;
				case "not_integer":
					return t`Enter a whole number`;
				case "too_small": {
					const minimum = issue.minimum ?? 0;
					if (issue.origin === "array") {
						return plural(minimum, { one: "Add at least # item", other: "Add at least # items" });
					}
					if (issue.origin === "string") {
						return plural(minimum, {
							one: "Use at least # character",
							other: "Use at least # characters",
						});
					}
					const formatted = i18n.number(minimum);
					return t`Enter ${formatted} or more`;
				}
				case "too_big": {
					const maximum = issue.maximum ?? 0;
					if (issue.origin === "array") {
						return plural(maximum, { one: "Keep to # item", other: "Keep to # items" });
					}
					if (issue.origin === "string") {
						return plural(maximum, {
							one: "Use at most # character",
							other: "Use at most # characters",
						});
					}
					const formatted = i18n.number(maximum);
					return t`Enter ${formatted} or less`;
				}
			}
		},
		[t, i18n],
	);
}

type MenuAction =
	| { kind: "delete" }
	| { kind: "add"; side: InsertSide; invoker: HTMLElement | null };

function nestedDescriptor(
	field: LayoutFieldDefinition,
	block: StoredBlockValue,
	id?: string,
): NestedFieldDescriptor {
	const options = Array.isArray(field.validation?.options)
		? field.validation.options
				.filter((option): option is string => typeof option === "string")
				.map((option) => ({ value: option, label: option }))
		: field.options;
	return {
		...(id ? { id } : {}),
		kind: NESTED_KIND[field.type] ?? "unsupported",
		label: splitLabelHint(field.label).label,
		required: field.required,
		validation: field.validation,
		blockType: block._type,
		blockVersion: block._version,
		options,
		...(field.type === "integer" ? { integer: true } : {}),
	};
}

function listFieldDefinition({ options, ...subField }: ListSubField): LayoutFieldDefinition {
	return options ? { ...subField, validation: { options } } : subField;
}

function listLimit(field: LayoutFieldDefinition, key: "minItems" | "maxItems") {
	const value = field.validation?.[key];
	return typeof value === "number" ? value : undefined;
}

/** Calls `callback` when focus leaves the element, rather than moving within it. */
function onFocusLeave(callback: () => void) {
	return (event: React.FocusEvent<HTMLElement>) => {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		callback();
	};
}

/**
 * One Undo toast for a blocks field, offered for its latest deletion: of a block or of a
 * list item inside one. Offering another, or dismissing, closes the toast before its Undo can act.
 */
function useUndoToast() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const { close } = toastManager;
	const currentRef = React.useRef<{ id: string; owner: UndoOwner } | null>(null);

	const dismiss = React.useCallback(() => {
		const current = currentRef.current;
		if (!current) return;
		currentRef.current = null;
		close(current.id);
	}, [close]);

	React.useEffect(
		() => () => {
			if (currentRef.current) close(currentRef.current.id);
		},
		[close],
	);

	const offer = (title: string, owner: UndoOwner, restore: () => void) => {
		dismiss();
		const id: string = toastManager.add({
			title,
			timeout: UNDO_TIMEOUT_MS,
			actions: [
				{
					children: t`Undo`,
					variant: "secondary",
					size: "sm",
					onClick: () => {
						if (currentRef.current?.id !== id) return;
						dismiss();
						restore();
					},
				},
			],
		});
		currentRef.current = { id, owner };
	};

	return { offer, dismiss, owner: () => currentRef.current?.owner };
}

export function BlocksField({
	id,
	fieldId,
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
	reveal,
}: BlocksFieldProps) {
	const { t } = useLingui();
	const undo = useUndoToast();
	const blocks = Array.isArray(value) ? value.filter(isStoredBlockValue) : [];
	const rootRef = React.useRef<HTMLDivElement>(null);
	const addButtonRef = React.useRef<HTMLButtonElement>(null);
	const focusRequestRef = React.useRef<FocusRequest | null>(null);
	const maxHintId = React.useId();
	const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
	const [advancedKeys, setAdvancedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
	const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
	const [revealedKeys, setRevealedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
	const revealTokenRef = React.useRef(reveal?.token ?? 0);
	const [revealFocus, setRevealFocus] = React.useState<FocusRequest | null>(null);
	const [itemReveal, setItemReveal] = React.useState<ItemReveal | null>(null);
	const [picker, setPicker] = React.useState<PickerTarget | null>(null);
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [confirmDelete, setConfirmDelete] = React.useState<{
		block: StoredBlockValue;
		open: boolean;
	} | null>(null);
	const [announcement, setAnnouncement] = React.useState("");

	const typeBySlug = React.useMemo(
		() => new Map(blockTypes.map((blockType) => [blockType.slug, blockType])),
		[blockTypes],
	);
	const insertable = allowedTypes
		.map((slug) => typeBySlug.get(slug))
		.filter((blockType): blockType is BlockType => blockType !== undefined);
	const atMax = blocks.length >= maxItems;
	const canAdd = !readOnly && !atMax && insertable.length > 0;
	const maxHint = plural(maxItems, {
		one: "This field holds up to # block.",
		other: "This field holds up to # blocks.",
	});
	const anyOpen = blocks.some((block) => openKeys.has(block._key));
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
	const blockLabel = (block: StoredBlockValue) => typeBySlug.get(block._type)?.label ?? block._type;
	const shownIssues = new Map<string, BlockValueIssue[]>();
	if (!readOnly) {
		for (const issue of validateBlocks(blocks, blockTypes)) {
			if (
				!revealedKeys.has(issue.blockKey) &&
				!touched.has(touchKey(issue.blockKey, issue.field)) &&
				!touched.has(touchKey(issue.blockKey, issue.path))
			) {
				continue;
			}
			shownIssues.set(issue.blockKey, [...(shownIssues.get(issue.blockKey) ?? []), issue]);
		}
	}

	const touchField = (blockKey: string, path: string) => {
		const key = touchKey(blockKey, path);
		setTouched((current) => (current.has(key) ? current : new Set(current).add(key)));
	};

	const revealIssues = useStableCallback((token: number, focusId: string | undefined) => {
		if (readOnly) return;
		setRevealedKeys(new Set(blocks.map((block) => block._key)));
		const block = focusId
			? blocks.find((candidate) => focusId.startsWith(`field-${fieldPath}.${candidate._key}.`))
			: undefined;
		if (!block || !focusId) return;
		const path = focusId.slice(`field-${fieldPath}.${block._key}.`.length);
		const [field = path, item] = path.split(".");
		const index = Number(item);
		setItemReveal(
			item !== undefined && Number.isInteger(index)
				? { blockKey: block._key, field, index, token }
				: null,
		);
		const version = typeBySlug
			.get(block._type)
			?.versions.find((candidate) => candidate.version === block._version);
		const advanced = version ? planBlockFields(version.fields, "block").advanced : [];
		if (advanced.some((candidate) => candidate.slug === field)) {
			setAdvancedKeys((current) => new Set(current).add(block._key));
		}
		setOpenKeys((current) => new Set(current).add(block._key));
		setRevealFocus({ key: block._key, target: "field", elementId: focusId, field });
	});

	const revealToken = reveal?.token ?? 0;
	const revealFocusId = reveal?.focusId;
	React.useEffect(() => {
		if (revealToken === revealTokenRef.current) return;
		revealTokenRef.current = revealToken;
		revealIssues(revealToken, revealFocusId);
	}, [revealToken, revealFocusId, revealIssues]);

	// Hands the focus over a render later, once the block, its Advanced row and any list item have opened.
	React.useEffect(() => {
		if (!revealFocus) return;
		focusRequestRef.current = revealFocus;
		setRevealFocus(null);
		setItemReveal(null);
	}, [revealFocus]);

	React.useEffect(() => {
		const request = focusRequestRef.current;
		const root = rootRef.current;
		if (!request || !root) return;
		if (request.target === "add") {
			focusRequestRef.current = null;
			addButtonRef.current?.focus();
			return;
		}
		const row = [...root.querySelectorAll<HTMLElement>("[data-block-key]")].find(
			(element) => element.dataset.blockKey === request.key,
		);
		if (!row) return;
		focusRequestRef.current = null;
		const toggle = row.querySelector<HTMLElement>("[data-block-toggle]");
		if (request.target === "item") {
			const list = [...row.querySelectorAll<HTMLElement>("[data-block-body] [data-field]")].find(
				(element) => element.dataset.field === request.field,
			);
			const item = list?.querySelectorAll<HTMLElement>("[data-list-item]")[request.index];
			(
				focusableIn(item?.querySelector("[data-item-focus]")) ??
				focusableIn(item) ??
				toggle
			)?.focus();
			return;
		}
		if (request.target === "field") {
			const { elementId } = request;
			const focusField = () => {
				const field = [...row.querySelectorAll<HTMLElement>("[data-block-body] [data-field]")].find(
					(element) => element.dataset.field === request.field,
				);
				(focusableIn(document.getElementById(elementId)) ?? focusableIn(field) ?? toggle)?.focus();
			};
			// A labelled Kumo input inside a list takes the id it was given only after its first render.
			if (focusableIn(document.getElementById(elementId))) focusField();
			else requestAnimationFrame(focusField);
			return;
		}
		const control =
			request.target === "first-control"
				? row.querySelector<HTMLElement>(`[data-block-body] :is(${FOCUSABLE})`)
				: null;
		(control ?? toggle)?.focus();
	});

	const listMaxItems = (block: StoredBlockValue, field: string) => {
		const definition = typeBySlug
			.get(block._type)
			?.versions.find((candidate) => candidate.version === block._version)
			?.fields.find((candidate) => candidate.slug === field);
		return (definition && listLimit(definition, "maxItems")) ?? Infinity;
	};

	// Undo can't put back what no longer fits, or anything once the field is read-only.
	React.useEffect(() => {
		const owner = undo.owner();
		if (!owner) return;
		if (readOnly) {
			undo.dismiss();
			return;
		}
		if (owner.kind === "block") {
			if (atMax) undo.dismiss();
			return;
		}
		const block = blocks.find((candidate) => candidate._key === owner.blockKey);
		const items = block?.[owner.field];
		if (!block || (Array.isArray(items) && items.length >= listMaxItems(block, owner.field))) {
			undo.dismiss();
		}
	});

	const openPicker = (target: PickerTarget) => {
		setPicker(target);
		setPickerOpen(true);
	};

	const insertBlock = (blockType: BlockType) => {
		if (!picker) return;
		const block = createBlockValue(blockType, createBlockKey());
		onChange(insertBlockValue(blocks, block, picker.index));
		setOpenKeys((current) => new Set(current).add(block._key));
		setPickerOpen(false);
		focusRequestRef.current = { key: block._key, target: "first-control" };
	};

	const toggleBlock = (key: string) => setOpenKeys((current) => toggled(current, key));
	const toggleAdvanced = (key: string) => setAdvancedKeys((current) => toggled(current, key));

	const duplicateBlock = (index: number) => {
		const block = blocks[index];
		if (!block) return;
		const copy = duplicateBlockValue(block, createBlockKey());
		onChange(insertBlockValue(blocks, copy, index + 1));
		setOpenKeys((current) => new Set(current).add(copy._key));
	};

	const moveBlock = (from: number, to: number) => {
		const block = blocks[from];
		if (!block || to < 0 || to >= blocks.length) return;
		onChange(moveBlockValue(blocks, from, to));
		const name = blockLabel(block);
		const position = to + 1;
		const total = blocks.length;
		setAnnouncement(t`Moved ${name} to position ${position} of ${total}`);
	};

	const removeBlock = (key: string): number => {
		const index = blocks.findIndex((block) => block._key === key);
		if (index < 0) return index;
		const next = blocks.filter((block) => block._key !== key);
		onChange(next);
		const neighbour = next[index] ?? next[index - 1];
		focusRequestRef.current = neighbour
			? { key: neighbour._key, target: "toggle" }
			: { target: "add" };
		return index;
	};

	const restoreBlock = useStableCallback((block: StoredBlockValue, index: number) => {
		if (blocks.some((candidate) => candidate._key === block._key)) return;
		onChange(insertBlockValue(blocks, block, index));
		focusRequestRef.current = { key: block._key, target: "toggle" };
	});

	const canRestore = (block: StoredBlockValue) => {
		const blockType = typeBySlug.get(block._type);
		const version = blockType?.versions.find((candidate) => candidate.version === block._version);
		return Boolean(
			blockType &&
			version &&
			!version.unsupportedTypes?.length &&
			block._version === blockType.currentVersion &&
			allowedTypes.includes(block._type) &&
			!retiredTypes.includes(block._type),
		);
	};

	const deleteBlock = (block: StoredBlockValue) => {
		if (!canRestore(block)) {
			setConfirmDelete({ block, open: true });
			return;
		}
		const index = removeBlock(block._key);
		if (index < 0) return;
		const name = blockLabel(block);
		undo.offer(t`Deleted ${name}`, { kind: "block" }, () => restoreBlock(block, index));
	};

	const restoreListItem = useStableCallback(
		(blockKey: string, field: string, { item, index }: DeletedListItem) => {
			const block = blocks.find((candidate) => candidate._key === blockKey);
			if (!block) return;
			const current = block[field];
			const items = Array.isArray(current) ? [...current] : [];
			const at = Math.min(index, items.length);
			items.splice(at, 0, item);
			onChange(updateBlockFieldValue(blocks, blockKey, field, items));
			focusRequestRef.current = { key: blockKey, target: "item", field, index: at };
		},
	);

	const offerItemUndo = (blockKey: string, field: string, deleted: DeletedListItem) => {
		const name = deleted.name;
		undo.offer(t`Deleted ${name}`, { kind: "item", blockKey, field }, () =>
			restoreListItem(blockKey, field, deleted),
		);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		if (!event.over || event.active.id === event.over.id) return;
		const from = blocks.findIndex((block) => block._key === event.active.id);
		const to = blocks.findIndex((block) => block._key === event.over?.id);
		onChange(moveBlockValue(blocks, from, to));
	};

	const confirmBlock = confirmDelete?.block;
	const confirmName = confirmBlock ? blockLabel(confirmBlock) : "";
	const confirmType = confirmBlock ? typeBySlug.get(confirmBlock._type) : undefined;
	const confirmVersion = confirmType?.versions.find(
		(candidate) => candidate.version === confirmBlock?._version,
	);
	let confirmReason = t`This block uses an older version of its type, so it can't be restored after you delete it.`;
	if (!confirmVersion || confirmVersion.unsupportedTypes?.length) {
		confirmReason = t`This block's stored definition is unavailable, so it can't be restored after you delete it.`;
	} else if (
		confirmBlock &&
		(retiredTypes.includes(confirmBlock._type) || !allowedTypes.includes(confirmBlock._type))
	) {
		confirmReason = t`This block type can no longer be added to this field, so the block can't be restored after you delete it.`;
	}

	const addButton = (
		<Button
			ref={addButtonRef}
			variant="ghost"
			icon={<Plus className="size-4" aria-hidden="true" />}
			aria-haspopup="dialog"
			aria-disabled={!canAdd || undefined}
			aria-describedby={atMax ? maxHintId : undefined}
			className={cn(
				"h-10 w-full justify-start gap-2 rounded-none px-2.5 font-normal text-kumo-subtle shadow-none hover:text-kumo-default aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
				SHEET_INNER_BOTTOM,
				blocks.length > 0 && "border-t border-kumo-hairline",
			)}
			onClick={(event) => {
				if (!canAdd) return;
				openPicker({
					index: blocks.length,
					anchor: event.currentTarget,
					side: "bottom",
					invoker: event.currentTarget,
				});
			}}
		>
			{t`Add block`}
		</Button>
	);

	return (
		<div id={id} ref={rootRef} className="@container/blocks grid grid-cols-[minmax(0,1fr)] gap-2">
			<div className="flex min-h-7 items-center justify-between gap-3">
				<Label>{label}</Label>
				{blocks.length > 0 && !readOnly && (
					<Button
						variant="ghost"
						size="sm"
						className="text-kumo-subtle"
						icon={
							anyOpen ? (
								<ArrowsInSimple className="size-3.5" aria-hidden="true" />
							) : (
								<ArrowsOutSimple className="size-3.5" aria-hidden="true" />
							)
						}
						onClick={() =>
							setOpenKeys(anyOpen ? new Set() : new Set(blocks.map((block) => block._key)))
						}
					>
						{anyOpen ? t`Collapse all` : t`Expand all`}
					</Button>
				)}
			</div>

			<div className="relative rounded-lg border border-kumo-line bg-kumo-base">
				{blocks.length > 0 ? (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={blocks.map((block) => block._key)}
							strategy={verticalListSortingStrategy}
						>
							<div role="list" aria-label={label}>
								{blocks.map((block, index) => (
									<BlockRow
										key={block._key}
										outerId={fieldId ?? id}
										fieldPath={fieldPath}
										block={block}
										index={index}
										count={blocks.length}
										blockType={typeBySlug.get(block._type)}
										retired={retiredTypes.includes(block._type)}
										open={readOnly || openKeys.has(block._key)}
										advancedOpen={readOnly || advancedKeys.has(block._key)}
										issues={shownIssues.get(block._key) ?? NO_ISSUES}
										itemReveal={itemReveal?.blockKey === block._key ? itemReveal : undefined}
										readOnly={readOnly}
										canAdd={canAdd}
										atMax={atMax}
										maxHint={maxHint}
										maxHintId={maxHintId}
										roundBottom={readOnly && index === blocks.length - 1}
										onToggle={() => toggleBlock(block._key)}
										onAdvancedToggle={() => toggleAdvanced(block._key)}
										onTouch={(path) => touchField(block._key, path)}
										onItemDeleted={(field, deleted) => offerItemUndo(block._key, field, deleted)}
										onChange={(field, nextValue) =>
											onChange(updateBlockFieldValue(blocks, block._key, field, nextValue))
										}
										onAdd={openPicker}
										onDuplicate={() => duplicateBlock(index)}
										onMove={(to) => moveBlock(index, to)}
										onDelete={() => deleteBlock(block)}
										renderField={renderField}
									/>
								))}
							</div>
						</SortableContext>
					</DndContext>
				) : (
					<p
						className={cn(
							"px-4 pt-6 text-center text-sm text-kumo-subtle",
							readOnly ? "pb-6" : "pb-2",
						)}
					>
						{t`No blocks yet`}
					</p>
				)}
				{!readOnly && (atMax ? <Tooltip content={maxHint} render={addButton} /> : addButton)}
			</div>

			{blocks.length < minItems && (
				<p className="text-sm text-kumo-danger">{t`Add at least ${minItems} blocks.`}</p>
			)}
			{atMax && !readOnly && (
				<span id={maxHintId} className="sr-only">
					{maxHint}
				</span>
			)}
			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>

			{!readOnly && (
				<BlockTypePicker
					open={pickerOpen}
					anchor={picker?.anchor ?? null}
					side={picker?.side ?? "bottom"}
					invoker={picker?.invoker ?? null}
					blockTypes={insertable}
					onPick={insertBlock}
					onClose={() => setPickerOpen(false)}
				/>
			)}
			<ConfirmDialog
				open={confirmDelete?.open ?? false}
				onClose={() => setConfirmDelete((current) => current && { ...current, open: false })}
				role="alertdialog"
				title={t`Delete ${confirmName}?`}
				description={confirmReason}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={false}
				error={null}
				onConfirm={() => {
					if (confirmBlock && removeBlock(confirmBlock._key) >= 0) undo.dismiss();
					setConfirmDelete((current) => current && { ...current, open: false });
				}}
			/>
		</div>
	);
}

interface BlockRowProps {
	outerId: string;
	fieldPath: string;
	block: StoredBlockValue;
	index: number;
	count: number;
	blockType?: BlockType;
	retired: boolean;
	open: boolean;
	advancedOpen: boolean;
	/** Problems to show in this block. */
	issues: readonly BlockValueIssue[];
	/** Opens a closed item in one of the block's lists for a reveal. */
	itemReveal?: ItemReveal;
	readOnly: boolean;
	canAdd: boolean;
	atMax: boolean;
	maxHint: string;
	maxHintId: string;
	roundBottom: boolean;
	onToggle: () => void;
	onAdvancedToggle: () => void;
	/** Called when focus leaves the control at this path inside the block, or a list. */
	onTouch: (path: string) => void;
	onChange: (field: string, value: unknown) => void;
	onItemDeleted: (field: string, deleted: DeletedListItem) => void;
	onAdd: (target: PickerTarget) => void;
	onDuplicate: () => void;
	onMove: (to: number) => void;
	onDelete: () => void;
	renderField: BlocksFieldProps["renderField"];
}

function BlockRow({
	outerId,
	fieldPath,
	block,
	index,
	count,
	blockType,
	retired,
	open,
	advancedOpen,
	issues,
	itemReveal,
	readOnly,
	canAdd,
	atMax,
	maxHint,
	maxHintId,
	roundBottom,
	onToggle,
	onAdvancedToggle,
	onTouch,
	onChange,
	onItemDeleted,
	onAdd,
	onDuplicate,
	onMove,
	onDelete,
	renderField,
}: BlockRowProps) {
	const { t, i18n } = useLingui();
	const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: block._key,
		disabled: readOnly,
	});
	const rowId = React.useId();
	const headRef = React.useRef<HTMLDivElement>(null);
	const handleRef = React.useRef<HTMLButtonElement>(null);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const afterMenuCloseRef = React.useRef<MenuAction | null>(null);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [menuFromHandle, setMenuFromHandle] = React.useState(false);

	const label = blockType?.label ?? block._type;
	const version = blockType?.versions.find((candidate) => candidate.version === block._version);
	const unsupported = !blockType || !version || Boolean(version.unsupportedTypes?.length);
	const inactive = Boolean(blockType && block._version !== blockType.currentVersion);
	const summary = version
		? blockSummary(block, label, version.fields, {
				locale: i18n.locale,
				withMore: (list, more) => t`${list} +${more}`,
			})
		: null;
	const thumbnail = version ? firstPhotoUrl(block, version.fields) : undefined;
	const versionNumber = block._version;
	const labelId = `${rowId}-label`;
	const summaryId = `${rowId}-summary`;
	const bodyId = `${rowId}-body`;
	const versionId = `${rowId}-version`;
	const errorDotId = `${rowId}-errors`;
	const showErrorDot = !open && issues.length > 0;
	const toggleDescription = [showErrorDot && errorDotId, summary && summaryId]
		.filter(Boolean)
		.join(" ");

	const addFromMenu = (side: InsertSide) => {
		const invoker = menuFromHandle ? handleRef.current : triggerRef.current;
		afterMenuCloseRef.current = { kind: "add", side, invoker };
	};
	const runMenuAction = useStableCallback((action: MenuAction) => {
		if (action.kind === "delete") {
			onDelete();
			return;
		}
		if (!canAdd) return;
		const { side, invoker } = action;
		onAdd({ index: side === "top" ? index : index + 1, anchor: headRef.current, side, invoker });
	});

	const issueMessage = useIssueMessage();
	const blockPath = `${fieldPath}.${block._key}`;
	const issueAt = (path: string) => issues.find((issue) => issue.path === path);
	const renderList = (field: LayoutFieldDefinition, labelledBy: string) => {
		const listIssue = issueAt(field.slug);
		const invalidItems = new Set(
			issues.flatMap((issue) =>
				issue.field === field.slug && issue.item !== undefined ? [issue.item] : [],
			),
		);
		return (
			<BlockListField
				labelId={labelledBy}
				label={field.label}
				value={block[field.slug]}
				onChange={(items) => onChange(field.slug, items)}
				subFields={repeaterSubFields(field)}
				minItems={listLimit(field, "minItems")}
				maxItems={listLimit(field, "maxItems")}
				readOnly={readOnly}
				error={listIssue && issueMessage(listIssue)}
				invalidItems={invalidItems}
				reveal={itemReveal?.field === field.slug ? itemReveal : undefined}
				onItemDeleted={(deleted) => onItemDeleted(field.slug, deleted)}
				renderControl={({ subField, at, onChange: onControlChange, ...control }) => {
					const definition = listFieldDefinition(subField);
					const path = `${field.slug}.${at}.${subField.slug}`;
					return (
						<FieldControl
							field={definition}
							name={`${blockPath}.${path}`}
							descriptor={nestedDescriptor(definition, block)}
							issue={issueAt(path)}
							{...control}
							onChange={onControlChange}
							onTouch={() => onTouch(path)}
							renderField={renderField}
						/>
					);
				}}
				renderItemFields={({ at, item, subFields, onChange: onItemChange }) => (
					<BlockFields
						scope="item"
						fields={subFields.map(listFieldDefinition)}
						values={item}
						namePrefix={`${blockPath}.${field.slug}.${at}`}
						describe={(definition) => nestedDescriptor(definition, block)}
						issueAt={(slug) => issueAt(`${field.slug}.${at}.${slug}`)}
						onTouch={(slug) => onTouch(`${field.slug}.${at}.${slug}`)}
						onChange={onItemChange}
						renderField={renderField}
					/>
				)}
			/>
		);
	};

	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			role="listitem"
			data-block-key={block._key}
			data-menu-open={menuOpen || undefined}
			className={cn(
				"group/block relative [--emdash-blocks-sticky-top:var(--emdash-editor-sticky-top,0px)]",
				index > 0 && "border-t border-kumo-hairline",
				isDragging && "opacity-50",
			)}
		>
			{!readOnly && (
				<div className="absolute end-full top-2.5 hidden items-center pe-1 opacity-0 transition-opacity blocks-gutter:flex group-hover/block:opacity-100 group-focus-within/block:opacity-100 group-data-[menu-open]/block:opacity-100">
					<Tooltip
						side="bottom"
						content={
							atMax ? (
								maxHint
							) : (
								<span className="block text-center">
									{t`Add block below`}
									<br />
									<Trans>
										<strong className="font-medium">Alt-click</strong> to add above
									</Trans>
								</span>
							)
						}
						render={
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								className="size-6 text-kumo-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
								aria-label={t`Add block below`}
								aria-haspopup="dialog"
								aria-disabled={!canAdd || undefined}
								aria-describedby={atMax ? maxHintId : undefined}
								onClick={(event) => {
									if (!canAdd) return;
									const above = event.altKey;
									onAdd({
										index: above ? index : index + 1,
										anchor: event.currentTarget,
										side: above ? "top" : "bottom",
										invoker: event.currentTarget,
									});
								}}
							>
								<Plus className="size-4" aria-hidden="true" />
							</Button>
						}
					/>
					<Tooltip
						side="bottom"
						className="cursor-grab active:cursor-grabbing"
						content={
							<span className="block text-center">
								<Trans>
									<strong className="font-medium">Drag</strong> to move
								</Trans>
								<br />
								<Trans>
									<strong className="font-medium">Click</strong> to open menu
								</Trans>
							</span>
						}
						render={
							<Button
								ref={handleRef}
								variant="ghost"
								shape="square"
								size="sm"
								className="h-6 w-[1.125rem] touch-none text-kumo-subtle"
								aria-label={t`Block actions - drag to reorder, click for menu`}
								aria-haspopup="menu"
								aria-expanded={menuOpen && menuFromHandle}
								{...listeners}
								onClick={() => {
									setMenuFromHandle(true);
									setMenuOpen(true);
								}}
							>
								<DotsSixVertical className="size-4" weight="bold" aria-hidden="true" />
							</Button>
						}
					/>
				</div>
			)}

			<div
				ref={headRef}
				className={cn(
					"flex min-h-11 items-center gap-2 py-1.5 ps-2.5 pe-2",
					!readOnly && "hover:bg-kumo-tint",
					index === 0 && SHEET_INNER_TOP,
					roundBottom && !open && SHEET_INNER_BOTTOM,
					open &&
						"sticky top-(--emdash-blocks-sticky-top) z-30 bg-kumo-base shadow-[inset_0_-1px_0_var(--color-kumo-hairline)]",
				)}
			>
				{readOnly ? (
					<div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
						<BlockTypeIcon
							name={blockType?.icon}
							className="size-[1.125rem] shrink-0 text-kumo-subtle"
						/>
						<span
							id={labelId}
							dir="auto"
							className="min-w-0 font-medium text-kumo-default wrap-anywhere"
						>
							{label}
						</span>
					</div>
				) : (
					<button
						type="button"
						data-block-toggle
						aria-expanded={open}
						aria-controls={bodyId}
						aria-labelledby={labelId}
						aria-describedby={toggleDescription || undefined}
						onClick={onToggle}
						className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
					>
						<CaretRight
							weight="bold"
							aria-hidden="true"
							className={cn(
								"size-3 shrink-0 text-kumo-subtle transition-transform rtl:-scale-x-100",
								open && "rotate-90 rtl:-rotate-90",
							)}
						/>
						<BlockTypeIcon
							name={blockType?.icon}
							className="size-[1.125rem] shrink-0 text-kumo-subtle"
						/>
						<span
							id={labelId}
							dir="auto"
							className="max-w-[60%] min-w-0 font-medium text-kumo-default wrap-anywhere"
						>
							{label}
						</span>
						{summary && (
							<span
								className={cn(
									"min-w-0 flex-1 overflow-hidden text-kumo-subtle transition-opacity",
									open && "opacity-0",
								)}
							>
								<span
									id={summaryId}
									dir="auto"
									className="inline-block max-w-full truncate align-top"
								>
									{summary}
								</span>
							</span>
						)}
					</button>
				)}
				{thumbnail && (
					<img
						key={thumbnail}
						src={thumbnail}
						alt=""
						loading="lazy"
						className={cn(
							"size-7 shrink-0 rounded-md object-cover ring-1 ring-kumo-line transition-opacity",
							open && "opacity-0",
						)}
						onError={(event) => {
							event.currentTarget.hidden = true;
						}}
					/>
				)}
				{showErrorDot && <ErrorDot id={errorDotId} />}
				{(inactive || retired || unsupported) && (
					<span className="flex flex-wrap justify-end gap-1">
						{inactive && <Badge variant="secondary">{t`Inactive version`}</Badge>}
						{retired && <Badge variant="secondary">{t`Retired`}</Badge>}
						{unsupported && <Badge variant="secondary">{t`Unsupported`}</Badge>}
					</span>
				)}
				{!readOnly && (
					<DropdownMenu
						open={menuOpen}
						onOpenChange={(next) => {
							if (next) setMenuFromHandle(false);
							setMenuOpen(next);
						}}
						onOpenChangeComplete={(isOpen) => {
							if (isOpen) return;
							const after = afterMenuCloseRef.current;
							afterMenuCloseRef.current = null;
							if (after) runMenuAction(after);
							else if (menuFromHandle) {
								// The menu returns focus to its trigger after this callback.
								setTimeout(() => {
									const active = document.activeElement;
									if (active === triggerRef.current || active === document.body) {
										handleRef.current?.focus();
									}
								});
							}
							setMenuFromHandle(false);
						}}
					>
						<DropdownMenu.Trigger
							render={
								<Button
									ref={triggerRef}
									variant="ghost"
									shape="square"
									size="sm"
									className="shrink-0 text-kumo-subtle blocks-gutter:opacity-0 blocks-gutter:group-hover/block:opacity-100 blocks-gutter:group-focus-within/block:opacity-100 blocks-gutter:group-data-[menu-open]/block:opacity-100"
									aria-label={t`${label} actions`}
									aria-describedby={versionId}
								>
									<DotsThree className="size-4" weight="bold" aria-hidden="true" />
								</Button>
							}
						/>
						<DropdownMenu.Content
							anchor={menuFromHandle ? handleRef : undefined}
							align={menuFromHandle ? "start" : "end"}
							className="min-w-56"
						>
							<DropdownMenu.Item
								icon={<RowsPlusTop className={MENU_ICON} aria-hidden="true" />}
								disabled={!canAdd}
								onClick={() => addFromMenu("top")}
							>
								{t`Add block above`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<RowsPlusBottom className={MENU_ICON} aria-hidden="true" />}
								disabled={!canAdd}
								onClick={() => addFromMenu("bottom")}
							>
								{t`Add block below`}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								icon={<Copy className={MENU_ICON} aria-hidden="true" />}
								disabled={retired || unsupported || inactive || atMax}
								onClick={onDuplicate}
							>
								{t`Duplicate`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<ArrowUp className={MENU_ICON} aria-hidden="true" />}
								disabled={index === 0}
								onClick={() => onMove(index - 1)}
							>
								{t`Move up`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<ArrowDown className={MENU_ICON} aria-hidden="true" />}
								disabled={index === count - 1}
								onClick={() => onMove(index + 1)}
							>
								{t`Move down`}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								variant="danger"
								icon={<Trash className={MENU_ICON} aria-hidden="true" />}
								onClick={() => {
									afterMenuCloseRef.current = { kind: "delete" };
								}}
							>
								{t`Delete`}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<div className="grid gap-0.5 px-2 py-1 text-xs text-kumo-subtle">
								<span>{t`${label} · version ${versionNumber}`}</span>
								{atMax && <span>{maxHint}</span>}
							</div>
						</DropdownMenu.Content>
					</DropdownMenu>
				)}
				{!readOnly && (
					<span id={versionId} className="sr-only">
						{t`Version ${block._version}`}
					</span>
				)}
			</div>

			{open && (
				<div
					id={bodyId}
					data-block-body
					role="group"
					aria-labelledby={labelId}
					className="px-2 pt-1 pb-4 [--emdash-editor-sticky-top:calc(var(--emdash-blocks-sticky-top)+2.75rem)] @min-[440px]/blocks:ps-9 @min-[440px]/blocks:pe-4"
				>
					{unsupported || !version ? (
						<p className="ps-2 text-sm text-kumo-subtle">
							{t`This block cannot be edited because its stored definition is unavailable.`}
						</p>
					) : (
						<BlockFields
							scope="block"
							fields={version.fields}
							values={block}
							namePrefix={blockPath}
							describe={(field) =>
								nestedDescriptor(field, block, `${outerId}:${block._key}:${field.slug}`)
							}
							issueAt={issueAt}
							advancedOpen={advancedOpen}
							onAdvancedToggle={onAdvancedToggle}
							onTouch={onTouch}
							onChange={onChange}
							renderField={renderField}
							renderList={renderList}
						/>
					)}
					<span className="sr-only">{t`Block ${index + 1}`}</span>
				</div>
			)}
		</div>
	);
}

interface ControlOptions {
	/** Replaces every other placeholder, as the two halves of a button row do. */
	placeholder?: string;
	/** Shown in an empty optional field that has no hint. */
	emptyPlaceholder?: string;
	heading?: boolean;
	thumbnail?: FieldChrome["thumbnail"];
	/** Keeps the hint and error for assistive technology only, as in a table cell, which has no room under it. */
	cell?: boolean;
}

interface FieldControlProps extends ControlOptions {
	field: LayoutFieldDefinition;
	/** The blocks field's path, then the path to this field inside it. */
	name: string;
	descriptor: NestedFieldDescriptor;
	value: unknown;
	issue?: BlockValueIssue;
	labelledBy: string;
	/** Where a reveal looks for the field when its control has no id to focus. */
	dataField?: string;
	onChange: (value: unknown) => void;
	/** Called when focus leaves the control. */
	onTouch: () => void;
	renderField: BlocksFieldProps["renderField"];
}

function isEmptyValue(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

function labelText(field: LayoutFieldDefinition): string {
	return splitLabelHint(field.label).label;
}

/** A field's quiet control, with its hint while focused and its error under it. */
function FieldControl({
	field,
	name,
	descriptor,
	value,
	issue,
	labelledBy,
	placeholder: placeholderOverride,
	emptyPlaceholder,
	heading,
	thumbnail,
	cell = false,
	dataField,
	onChange,
	onTouch,
	renderField,
}: FieldControlProps) {
	const { t } = useLingui();
	const issueMessage = useIssueMessage();
	const id = `field-${name}`;
	const { hint } = splitLabelHint(field.label);
	const placeholder =
		placeholderOverride ?? (field.required ? t`Required` : (hint ?? emptyPlaceholder ?? t`Empty`));
	const hintId = `${id}-hint`;
	const errorId = `${id}-error`;
	const error = issue ? issueMessage(issue, hint) : undefined;
	const errorShown =
		!cell &&
		issue !== undefined &&
		!(issue.code === "required" && REQUIRED_SHOWN_BY_CONTROL.has(field.type));
	const describedBy =
		[hint && error !== hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;
	const showHintOnFocus =
		!cell && Boolean(hint) && !errorShown && !(placeholder === hint && isEmptyValue(value));
	return (
		<div data-field={dataField} className="group/control min-w-0" onBlur={onFocusLeave(onTouch)}>
			{renderField({
				name,
				field: descriptor,
				value,
				onChange,
				chrome: {
					labelledBy,
					describedBy,
					placeholder,
					invalid: issue !== undefined,
					heading,
					thumbnail,
				},
			})}
			{hint && error !== hint && (
				<p
					id={hintId}
					className={cn("sr-only", showHintOnFocus && "group-focus-within/control:not-sr-only")}
				>
					<span className="block px-2 pt-1 text-xs leading-4 text-kumo-subtle">{hint}</span>
				</p>
			)}
			{error && (
				<p
					id={errorId}
					className={errorShown ? "px-2 pt-1 text-xs leading-4 text-kumo-danger" : "sr-only"}
				>
					{error}
				</p>
			)}
		</div>
	);
}

interface BlockFieldsProps {
	/** An open block's fields, or an open list item's sub-fields. */
	scope: "block" | "item";
	fields: readonly LayoutFieldDefinition[];
	values: Record<string, unknown>;
	/** The blocks field's path, then the path to these fields inside it. */
	namePrefix: string;
	describe: (field: LayoutFieldDefinition) => NestedFieldDescriptor;
	/** The problem to show at the field with this slug. */
	issueAt: (slug: string) => BlockValueIssue | undefined;
	advancedOpen?: boolean;
	onAdvancedToggle?: () => void;
	/** Called when focus leaves the control of the field with this slug. */
	onTouch: (slug: string) => void;
	onChange: (slug: string, value: unknown) => void;
	renderField: BlocksFieldProps["renderField"];
	renderList?: (field: LayoutFieldDefinition, labelId: string) => React.ReactNode;
}

function BlockFields({
	scope,
	fields,
	values,
	namePrefix,
	describe,
	issueAt,
	advancedOpen = false,
	onAdvancedToggle,
	onTouch,
	onChange,
	renderField,
	renderList,
}: BlockFieldsProps) {
	const { t } = useLingui();
	const plan = React.useMemo(() => planBlockFields(fields, scope), [fields, scope]);
	const advancedId = React.useId();

	if (fields.length === 0) {
		return scope === "block" ? (
			<p className="ps-2 text-sm text-kumo-subtle">{t`This block has no fields.`}</p>
		) : null;
	}

	const controlId = (field: LayoutFieldDefinition) => `field-${namePrefix}.${field.slug}`;
	const labelId = (field: LayoutFieldDefinition) => `${controlId(field)}-label`;

	const control = (
		field: LayoutFieldDefinition,
		labelledBy: string,
		options: ControlOptions = {},
	) => {
		if (field.type === "repeater" && renderList) {
			return (
				<div
					key={field.slug}
					data-field={field.slug}
					className="min-w-0"
					onBlur={onFocusLeave(() => onTouch(field.slug))}
				>
					{renderList(field, labelledBy)}
				</div>
			);
		}
		return (
			<FieldControl
				key={field.slug}
				field={field}
				name={`${namePrefix}.${field.slug}`}
				descriptor={describe(field)}
				value={values[field.slug]}
				issue={issueAt(field.slug)}
				labelledBy={labelledBy}
				{...options}
				dataField={scope === "block" ? field.slug : undefined}
				onChange={(nextValue) => onChange(field.slug, nextValue)}
				onTouch={() => onTouch(field.slug)}
				renderField={renderField}
			/>
		);
	};

	const stacked = (field: LayoutFieldDefinition, heading?: boolean) => {
		if (field.type === "repeater") return control(field, labelId(field));
		return (
			<div key={field.slug} className="grid min-w-0 gap-1">
				<label id={labelId(field)} htmlFor={controlId(field)} className={FIELD_LABEL}>
					{labelText(field)}
				</label>
				{control(field, labelId(field), { heading })}
			</div>
		);
	};

	const settingRow = (field: LayoutFieldDefinition) => (
		<div key={field.slug} className={SETTING_ROW}>
			{field.type === "image" ? (
				<span id={labelId(field)} className={SETTING_LABEL}>
					{labelText(field)}
				</span>
			) : (
				<label id={labelId(field)} htmlFor={controlId(field)} className={SETTING_LABEL}>
					{labelText(field)}
				</label>
			)}
			{control(field, labelId(field), field.type === "image" ? { thumbnail: "row" } : {})}
		</div>
	);

	const contentPart = (part: BlockFieldPart<LayoutFieldDefinition>) => {
		switch (part.kind) {
			case "field":
				return stacked(part.field, part.heading);
			case "columns":
				return (
					<div
						key={part.fields.map((field) => field.slug).join(":")}
						className={cn(
							"grid min-w-0 gap-x-1 gap-y-4",
							part.fields.length === 3
								? "@min-[440px]/blocks:grid-cols-3"
								: "@min-[440px]/blocks:grid-cols-2",
						)}
					>
						{part.fields.map((field) => stacked(field))}
					</div>
				);
			case "image": {
				const caption = part.caption;
				return (
					<div key={part.field.slug} className="grid min-w-0 gap-1">
						<span id={labelId(part.field)} className={FIELD_LABEL}>
							{labelText(part.field)}
						</span>
						{control(part.field, labelId(part.field))}
						{caption && (
							<>
								<span id={labelId(caption)} hidden>
									{labelText(caption)}
								</span>
								{control(caption, labelId(caption), { emptyPlaceholder: t`Add a caption` })}
							</>
						)}
					</div>
				);
			}
			case "button":
				return null;
		}
	};

	const settingPart = (part: BlockFieldPart<LayoutFieldDefinition>) => {
		if (part.kind === "field" || part.kind === "image") return settingRow(part.field);
		if (part.kind !== "button") return null;
		const rowLabelId = `${controlId(part.text)}-row`;
		return (
			<div key={part.text.slug} role="group" aria-labelledby={rowLabelId} className={SETTING_ROW}>
				<label id={rowLabelId} htmlFor={controlId(part.text)} className={SETTING_LABEL}>
					{part.label}
				</label>
				<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(5.5rem,11em)] items-start gap-1">
					<span id={labelId(part.text)} hidden>
						{labelText(part.text)}
					</span>
					{control(part.text, labelId(part.text), { placeholder: t`Text` })}
					<span id={labelId(part.link)} hidden>
						{labelText(part.link)}
					</span>
					{control(part.link, labelId(part.link), { placeholder: t`Link` })}
				</div>
			</div>
		);
	};

	const advancedSummary = plan.advanced
		.map((field) => values[field.slug])
		.filter((value): value is string => typeof value === "string" && value.trim() !== "")
		.join(" · ");

	return (
		<>
			{plan.content.length > 0 && <div className="grid gap-4">{plan.content.map(contentPart)}</div>}
			{plan.settings.length > 0 && (
				<div
					className={cn(
						"grid gap-0.5",
						plan.content.length > 0 && "mt-4 border-t border-kumo-hairline pt-3",
					)}
				>
					{plan.settings.map(settingPart)}
				</div>
			)}
			{plan.advanced.length > 0 && (
				<div className={cn(plan.content.length + plan.settings.length > 0 && "mt-2")}>
					<button
						type="button"
						aria-expanded={advancedOpen}
						aria-controls={advancedId}
						onClick={onAdvancedToggle}
						className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-start text-sm text-kumo-subtle outline-none hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand"
					>
						<CaretRight
							weight="bold"
							aria-hidden="true"
							className={cn(
								"size-2.5 shrink-0 transition-transform rtl:-scale-x-100",
								advancedOpen && "rotate-90 rtl:-rotate-90",
							)}
						/>
						<SlidersHorizontal className="size-3.5 shrink-0" aria-hidden="true" />
						<span className="shrink-0">{t`Advanced`}</span>
						{!advancedOpen && advancedSummary && (
							<span dir="auto" className="min-w-0 truncate text-kumo-placeholder">
								{advancedSummary}
							</span>
						)}
						{!advancedOpen && plan.advanced.some((field) => issueAt(field.slug)) && <ErrorDot />}
					</button>
					{advancedOpen && (
						<div id={advancedId} className="grid gap-0.5">
							{plan.advanced.map(settingRow)}
						</div>
					)}
				</div>
			)}
		</>
	);
}
