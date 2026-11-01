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
	Trash,
} from "@phosphor-icons/react";
import * as React from "react";

import type { BlockFieldDefinition, BlockType } from "../lib/api/schema.js";
import { blockSummary } from "../lib/block-field-layout.js";
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
import { useStableCallback } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import { BlockTypeIcon, BlockTypePicker } from "./BlockTypePicker.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { type ImageFieldValue, mediaDisplayUrl } from "./ImageFieldRenderer.js";

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

interface NestedFieldRenderInput {
	name: string;
	field: NestedFieldDescriptor;
	value: unknown;
	onChange: (value: unknown) => void;
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

const UNDO_TIMEOUT_MS = 6000;
const FOCUSABLE =
	'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const SHEET_INNER_TOP = "rounded-t-[calc(var(--radius-lg)-1px)]";
const SHEET_INNER_BOTTOM = "rounded-b-[calc(var(--radius-lg)-1px)]";
const MENU_ICON = "me-2 size-4";

type InsertSide = "top" | "bottom";

interface PickerTarget {
	index: number;
	anchor: Element | null;
	side: InsertSide;
	invoker: HTMLElement | null;
}

type FocusRequest = { key: string; target: "first-control" | "toggle" } | { target: "add" };

type MenuAction =
	| { kind: "delete" }
	| { kind: "add"; side: InsertSide; invoker: HTMLElement | null };

function nestedDescriptor(
	outerId: string,
	blockKey: string,
	blockType: string,
	blockVersion: number,
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
		blockType,
		blockVersion,
		options,
		...(field.type === "integer" ? { integer: true } : {}),
	};
}

function isImageValue(value: unknown): value is ImageFieldValue {
	return (
		typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
	);
}

function blockThumbnail(
	block: StoredBlockValue,
	fields: readonly BlockFieldDefinition[],
): string | undefined {
	for (const field of fields) {
		if (field.type !== "image") continue;
		const value = block[field.slug];
		const url =
			typeof value === "string" || isImageValue(value) ? mediaDisplayUrl(value) : undefined;
		if (url) return url;
	}
	return undefined;
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
}: BlocksFieldProps) {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const { close: closeToast } = toastManager;
	const blocks = Array.isArray(value) ? value.filter(isStoredBlockValue) : [];
	const rootRef = React.useRef<HTMLDivElement>(null);
	const addButtonRef = React.useRef<HTMLButtonElement>(null);
	const focusRequestRef = React.useRef<FocusRequest | null>(null);
	const undoToastRef = React.useRef<string | null>(null);
	const maxHintId = React.useId();
	const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
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
		const control =
			request.target === "first-control"
				? row.querySelector<HTMLElement>(`[data-block-body] :is(${FOCUSABLE})`)
				: null;
		(control ?? row.querySelector<HTMLElement>("[data-block-toggle]"))?.focus();
	});

	React.useEffect(
		() => () => {
			if (undoToastRef.current) closeToast(undoToastRef.current);
		},
		[closeToast],
	);

	React.useEffect(() => {
		if (!(readOnly || atMax) || !undoToastRef.current) return;
		closeToast(undoToastRef.current);
		undoToastRef.current = null;
	}, [readOnly, atMax, closeToast]);

	const dismissUndo = () => {
		if (!undoToastRef.current) return;
		closeToast(undoToastRef.current);
		undoToastRef.current = null;
	};

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

	const toggleBlock = (key: string) =>
		setOpenKeys((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

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
		dismissUndo();
		const name = blockLabel(block);
		const toastId: string = toastManager.add({
			title: t`Deleted ${name}`,
			timeout: UNDO_TIMEOUT_MS,
			actions: [
				{
					children: t`Undo`,
					variant: "secondary",
					size: "sm",
					onClick: () => {
						if (undoToastRef.current !== toastId) return;
						dismissUndo();
						restoreBlock(block, index);
					},
				},
			],
		});
		undoToastRef.current = toastId;
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
		<div id={id} ref={rootRef} className="grid grid-cols-[minmax(0,1fr)] gap-2">
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
										readOnly={readOnly}
										canAdd={canAdd}
										atMax={atMax}
										maxHint={maxHint}
										maxHintId={maxHintId}
										roundBottom={readOnly && index === blocks.length - 1}
										onToggle={() => toggleBlock(block._key)}
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
				compact
				title={t`Delete ${confirmName}?`}
				description={confirmReason}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={false}
				error={null}
				onConfirm={() => {
					if (confirmBlock && removeBlock(confirmBlock._key) >= 0) dismissUndo();
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
	readOnly: boolean;
	canAdd: boolean;
	atMax: boolean;
	maxHint: string;
	maxHintId: string;
	roundBottom: boolean;
	onToggle: () => void;
	onChange: (field: string, value: unknown) => void;
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
	readOnly,
	canAdd,
	atMax,
	maxHint,
	maxHintId,
	roundBottom,
	onToggle,
	onChange,
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
	const thumbnail = version ? blockThumbnail(block, version.fields) : undefined;
	const versionNumber = block._version;
	const labelId = `${rowId}-label`;
	const summaryId = `${rowId}-summary`;
	const bodyId = `${rowId}-body`;
	const versionId = `${rowId}-version`;

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
						aria-describedby={summary ? summaryId : undefined}
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
					className="space-y-4 px-4 pt-2 pb-4 [--emdash-editor-sticky-top:calc(var(--emdash-blocks-sticky-top)+2.75rem)]"
				>
					{unsupported ? (
						<p className="text-sm text-kumo-subtle">
							{t`This block cannot be edited because its stored definition is unavailable.`}
						</p>
					) : (
						version?.fields.map((field) =>
							renderField({
								name: `${fieldPath}.${block._key}.${field.slug}`,
								field: nestedDescriptor(outerId, block._key, block._type, block._version, field),
								value: block[field.slug],
								onChange: (nextValue) => onChange(field.slug, nextValue),
							}),
						)
					)}
					<span className="sr-only">{t`Block ${index + 1}`}</span>
				</div>
			)}
		</div>
	);
}
