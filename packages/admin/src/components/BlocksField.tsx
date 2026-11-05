import { Badge, Button, DropdownMenu, Label, Tooltip } from "@cloudflare/kumo";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
	ArrowsInSimple,
	ArrowsOutSimple,
	DotsSixVertical,
	DotsThree,
	Plus,
	WarningCircle,
} from "@phosphor-icons/react";
import * as React from "react";
import { flushSync } from "react-dom";

import type { BlockType } from "../lib/api/schema.js";
import {
	blockSummary,
	type BlockFieldPart,
	isLinkField,
	itemTitleField,
	type LayoutFieldDefinition,
	listPresentation,
	type ListSubField,
	planBlockFields,
	repeaterSubFields,
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
import {
	blockIssueElementId,
	type BlockValueIssue,
	validateBlocks,
} from "../lib/block-validation.js";
import { useStableCallback } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import {
	focusableIn,
	keepEnterInBlocks,
	MOVE_KEYS,
	onFocusLeave,
	useMoveKeys,
	usePressWatch,
} from "./block-field-keyboard.js";
import {
	bringIntoView,
	collapseRow,
	DisclosureCaret,
	DisclosurePanel,
	growRow,
	keepRowInView,
	prefersReducedMotion,
	useDropSettle,
	useReorderMotion,
} from "./block-field-motion.js";
import {
	isEmptyValue,
	NOTE_DOT,
	type NotedControl,
	NotedField,
	type NoteSource,
	useControlNotes,
	useIssueMessage,
} from "./block-field-notes.js";
import {
	BLOCK_TITLE,
	DRAGGING,
	FIELD_GAP,
	GLYPH_NUDGE,
	HEAD_FOCUS,
	HEAD_PRESSED,
	IMAGE_EDGE,
	LABEL,
	NOTE,
	NOTE_ON_FOCUS,
	LIFT_SHADOW,
	LIFTED,
	MENU_TOUCH,
	POPUP_MOTION,
	ROW_BUTTON,
	ROW_HOVER,
	ROW_SUMMARY,
	SORT_TRANSITION,
	SUMMARY_SLOT,
	SUMMARY_TEXT,
	TOUCH_HEIGHT,
	TOUCH_TARGET,
} from "./block-field-styles.js";
import { UndoContext, usePhotoUndo, useToastClearance, useUndoToast } from "./block-field-undo.js";
import {
	BlockListField,
	type DeletedListItem,
	type DeletionHold,
	ErrorDot,
	firstPhotoUrl,
	toggled,
} from "./BlockListField.js";
import { BlockTypeIcon, BlockTypePicker } from "./BlockTypePicker.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ImageRemovalContext } from "./ImageFieldRenderer.js";
import { RowMenuItems } from "./RowMenuItems.js";
import { useDragAnnouncements } from "./useDragAnnouncements.js";
import { useQuietReturnFocus } from "./useQuietReturnFocus.js";

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

/** How a block draws a nested field's control: the block draws the label and errors. */
export interface FieldChrome {
	/** Id of the element that names the control. */
	labelledBy: string;
	describedBy?: string;
	placeholder?: string;
	/** The placeholder names the control or says it's required, so it's drawn as readable text. */
	placeholderSays?: boolean;
	invalid?: boolean;
	/** The empty control's placeholder says its problem, so it's drawn as one. */
	emptyIssue?: boolean;
	/** Id of the element on the field's label line that shows the control's count or range. */
	countSlotId?: string;
	/** The block's headline, drawn larger. */
	heading?: boolean;
	/** Draws a photo as a thumbnail: in a list item's settings row, or in a table cell. */
	thumbnail?: "row" | "cell";
}

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
	/** How many problems the page's blocks fields hold, which the field with `focusId` says. */
	count?: number;
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

const SHEET_INNER_TOP = "rounded-t-[calc(var(--radius-lg)-1px)]";
const SHEET_INNER_BOTTOM = "rounded-b-[calc(var(--radius-lg)-1px)]";
const FIELD_LABEL = `${LABEL} ps-2 wrap-anywhere`;
// An item's fields start 1.5rem in from its block's, so inside an item the label column is that
// much narrower, and every settings value starts on one edge.
const SETTING_ROW =
	"grid min-w-0 items-start gap-x-2 @min-[440px]/blocks:grid-cols-[11rem_minmax(0,1fr)] @min-[440px]/blocks:in-data-list-item:grid-cols-[9.5rem_minmax(0,1fr)]";
// Beside its value, a label takes the value's size and the line box a 32px control centers its text
// in, so the two share a baseline and a wrapped label keeps its first line there.
const SIDE_LABEL_TEXT =
	"@min-[440px]/blocks:text-base @min-[440px]/blocks:leading-(--text-base--line-height) @min-[440px]/blocks:font-normal";
const SETTING_LABEL = `${LABEL} ps-2 wrap-anywhere @min-[440px]/blocks:min-h-8 @min-[440px]/blocks:py-[5.5px] ${SIDE_LABEL_TEXT}`;
// A block's gutter and menu show for the row under the pointer, the row whose menu or picker is
// open, and keyboard focus on themselves, never for a row that only holds focus from a click. The
// state being entered sets the duration, so they fade in and vanish at once.
const REVEAL_GUTTER =
	"opacity-0 transition-opacity duration-0 ease-emdash group-hover/block:opacity-100 group-hover/block:duration-100 group-data-[menu-open]/block:opacity-100 group-data-[menu-open]/block:duration-100 group-data-[picker-open]/block:opacity-100 group-data-[picker-open]/block:duration-100 [&:not([data-quiet-focus]):has(:focus-visible)]:opacity-100 [&:not([data-quiet-focus]):has(:focus-visible)]:duration-100";
// Touch and narrow screens have no hover, so their menus always show.
const REVEAL_MENU =
	"blocks-gutter:opacity-0 blocks-gutter:transition-opacity blocks-gutter:duration-0 blocks-gutter:ease-emdash blocks-gutter:group-hover/block:opacity-100 blocks-gutter:group-hover/block:duration-100 blocks-gutter:group-data-[menu-open]/block:opacity-100 blocks-gutter:group-data-[menu-open]/block:duration-100 blocks-gutter:[&:not([data-quiet-focus]):focus-visible]:opacity-100 blocks-gutter:[&:not([data-quiet-focus]):focus-visible]:duration-100";
// The head keeps its wash while its menu or picker is open, so the popup stays tied to its row.
const HEAD_POPUP_OPEN =
	"group-data-[menu-open]/block:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))] group-data-[picker-open]/block:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]";

type InsertSide = "top" | "bottom";

interface PickerTarget {
	index: number;
	anchor: Element | null;
	side: InsertSide;
	invoker: HTMLElement | null;
	/** The block whose gutter opened the picker. */
	from?: string;
	/** A tap opened the picker. */
	byTouch?: boolean;
}

/**
 * Where focus goes next. With `scroll: false`, the row's own motion brings it into view. With
 * `"nearest"`, it's brought into view only when it's out of view.
 */
type FocusRequest =
	| { key: string; target: "first-control" | "toggle"; scroll?: false | "nearest" }
	| {
			key: string;
			target: "field";
			elementId: string;
			field: string;
			/** Focuses that control, rather than the block's first problem on screen. */
			exact?: true;
	  }
	| { key: string; target: "item"; field: string; index: number; scroll?: false | "nearest" }
	| { target: "add" };

const NO_ISSUES: readonly BlockValueIssue[] = [];

/** The key of the block `element` is in, in any blocks field. */
export function blockKeyOf(element: Element | null): string | undefined {
	return element?.closest<HTMLElement>("[data-block-key]")?.dataset.blockKey;
}

function touchKey(blockKey: string, field: string): string {
	return `${blockKey}:${field}`;
}

function withKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
	return keys.has(key) ? keys : new Set(keys).add(key);
}

/**
 * Whether a problem shows before a Save reveals it. A list's size shows once a deletion changed
 * the list, a required value once it was edited and left empty, and any other problem once focus
 * leaves its field, so tabbing through a new block or item flags nothing.
 */
function issueReached(
	issue: BlockValueIssue,
	touched: ReadonlySet<string>,
	edited: ReadonlySet<string>,
): boolean {
	const key = touchKey(issue.blockKey, issue.path);
	if (issue.origin === "array") return edited.has(key);
	if (!touched.has(key)) return false;
	return issue.code !== "required" || edited.has(key);
}

/** The order an open block shows its fields in, by slug, and for each list its items' sub-fields. */
interface ViewOrder {
	fields: string[];
	subFields: Map<string, string[]>;
}

function partSlugs(part: BlockFieldPart<LayoutFieldDefinition>): string[] {
	switch (part.kind) {
		case "field":
			return [part.field.slug];
		case "columns":
			return part.fields.map((field) => field.slug);
		case "image":
			return part.caption ? [part.field.slug, part.caption.slug] : [part.field.slug];
		case "button":
			return [part.text.slug, part.link.slug];
	}
}

function planOrder(fields: readonly LayoutFieldDefinition[], scope: "block" | "item"): string[] {
	const plan = planBlockFields(fields, scope);
	const slugs = [...plan.content, ...plan.settings].flatMap(partSlugs);
	return [...slugs, ...plan.advanced.map((field) => field.slug)];
}

function viewOrderOf(
	block: StoredBlockValue,
	typeBySlug: ReadonlyMap<string, BlockType>,
): ViewOrder {
	const fields =
		typeBySlug.get(block._type)?.versions.find((version) => version.version === block._version)
			?.fields ?? [];
	const subFields = new Map<string, string[]>();
	for (const field of fields) {
		if (field.type !== "repeater") continue;
		const subs = repeaterSubFields(field);
		if (listPresentation(subs) !== "items") {
			subFields.set(
				field.slug,
				subs.map((sub) => sub.slug),
			);
			continue;
		}
		// An item heads its fields with its title, as BlockListField draws it.
		const title = itemTitleField(subs);
		const headTitle = title?.type === "string" ? title : undefined;
		const rest = subs.filter((sub) => sub !== headTitle).map(listFieldDefinition);
		subFields.set(field.slug, [...(headTitle ? [headTitle.slug] : []), ...planOrder(rest, "item")]);
	}
	return { fields: planOrder(fields, "block"), subFields };
}

/** Where `path` sits in view order: its block, its field, then its list item and sub-field. */
function viewRank({ fields, subFields }: ViewOrder, blockIndex: number, path: string): number[] {
	const [field = "", item, sub] = path.split(".");
	const index = Number(item);
	return [
		blockIndex,
		fields.indexOf(field),
		item !== undefined && Number.isFinite(index) ? index : -1,
		sub === undefined ? -1 : (subFields.get(field)?.indexOf(sub) ?? -1),
	];
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? -1) - (b[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** `issues`, found in the blocks of `value`, with their place in view order, top to bottom. */
function rankIssues(
	issues: readonly BlockValueIssue[],
	value: readonly unknown[],
	typeBySlug: ReadonlyMap<string, BlockType>,
): Array<{ issue: BlockValueIssue; rank: number[] }> {
	const orders = new Map<number, ViewOrder>();
	return issues
		.map((issue) => {
			const block = value[issue.blockIndex];
			if (!isStoredBlockValue(block)) return { issue, rank: [issue.blockIndex] };
			const order = orders.get(issue.blockIndex) ?? viewOrderOf(block, typeBySlug);
			orders.set(issue.blockIndex, order);
			return { issue, rank: viewRank(order, issue.blockIndex, issue.path) };
		})
		.toSorted((a, b) => compareRanks(a.rank, b.rank));
}

/** A blocks field's problems in the order its open blocks show them, top to bottom. */
export function issuesInViewOrder(
	issues: readonly BlockValueIssue[],
	value: unknown,
	blockTypes: readonly BlockType[],
): BlockValueIssue[] {
	const typeBySlug = new Map(blockTypes.map((blockType) => [blockType.slug, blockType]));
	return rankIssues(issues, Array.isArray(value) ? value : [], typeBySlug).map(
		({ issue }) => issue,
	);
}

type MenuAction =
	| { kind: "delete" }
	| { kind: "duplicate" }
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
		label: field.label,
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
	/** The open set Expand all or Collapse all made, which opens and closes without motion. */
	const [allToggled, setAllToggled] = React.useState<ReadonlySet<string> | null>(null);
	const [advancedKeys, setAdvancedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
	const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
	/** Paths whose value was changed here, and lists an item was deleted from. */
	const [edited, setEdited] = React.useState<ReadonlySet<string>>(() => new Set());
	/** The blocks whose problems a save showed. */
	const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(() => new Set());
	/** For each block, a token that opens its list items with a problem each time it changes. */
	const [itemReveals, setItemReveals] = React.useState<ReadonlyMap<string, number>>(
		() => new Map(),
	);
	const revealCountRef = React.useRef(0);
	const revealTokenRef = React.useRef(reveal?.token ?? 0);
	/**
	 * The last place in a block that had focus, or the last problem shown, after which the next
	 * problem is found. Its rank keeps the place once its control has left the page, or when the
	 * browser didn't focus it.
	 */
	const lastPlaceRef = React.useRef<{ element?: Element; rank?: number[] } | null>(null);
	const [revealFocus, setRevealFocus] = React.useState<FocusRequest | null>(null);
	const [picker, setPicker] = React.useState<PickerTarget | null>(null);
	/** What pressed last in the field or a popup it opened: a pointer's type, or the keyboard. */
	const pressRef = React.useRef("");
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [confirmDelete, setConfirmDelete] = React.useState<{
		block: StoredBlockValue;
		open: boolean;
	} | null>(null);
	const [announcement, setAnnouncement] = React.useState("");
	/** How many problems the latest reveal shows, said once per reveal. */
	const [revealSummary, setRevealSummary] = React.useState<{ token: number; text: string } | null>(
		null,
	);
	/** The block just added, duplicated or put back by Undo, which grows into place. */
	const [arrived, setArrived] = React.useState<{ key: string; restored?: true } | null>(null);
	const reorder = useReorderMotion(rootRef, "data-block-key");
	useToastClearance(rootRef);
	usePressWatch();

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
	let shownCount = 0;
	if (!readOnly) {
		for (const issue of validateBlocks(blocks, blockTypes)) {
			if (!revealed.has(issue.blockKey) && !issueReached(issue, touched, edited)) continue;
			shownIssues.set(issue.blockKey, [...(shownIssues.get(issue.blockKey) ?? []), issue]);
			shownCount += 1;
		}
	}
	// After a save shows problems, the count of those left stays in view until none are.
	const toFix = revealed.size > 0 ? shownCount : 0;
	if (revealSummary && shownCount === 0) setRevealSummary(null);

	const touchField = (blockKey: string, path: string) =>
		setTouched((current) => withKey(current, touchKey(blockKey, path)));
	const editField = (blockKey: string, path: string) =>
		setEdited((current) => withKey(current, touchKey(blockKey, path)));

	/**
	 * Moves the touched and edited paths of a list's items to the items' new positions. `moveTo`
	 * gives an item's new position by its old one, or -1 for an item removed.
	 */
	const moveListTouches = (blockKey: string, field: string, moveTo: (index: number) => number) => {
		const prefix = `${touchKey(blockKey, field)}.`;
		const move = (current: ReadonlySet<string>) => {
			const next = new Set<string>();
			for (const key of current) {
				if (!key.startsWith(prefix)) {
					next.add(key);
					continue;
				}
				const [index = "", ...rest] = key.slice(prefix.length).split(".");
				const to = moveTo(Number(index));
				if (to >= 0) next.add([`${prefix}${to}`, ...rest].join("."));
			}
			return next;
		};
		setTouched(move);
		setEdited(move);
	};

	const revealIssues = useStableCallback(
		(focusId: string | undefined, count: number | undefined) => {
			if (readOnly) return;
			const token = ++revealCountRef.current;
			setRevealed(new Set(blocks.map((block) => block._key)));
			setItemReveals(new Map(blocks.map((block) => [block._key, token])));
			const issues = validateBlocks(blocks, blockTypes);
			const block = focusId
				? blocks.find((candidate) => focusId.startsWith(`field-${fieldPath}.${candidate._key}.`))
				: undefined;
			// With several blocks fields on the page, the one that takes focus says the page's count.
			if (issues.length > 0 && (block || focusId === undefined)) {
				setRevealSummary({
					token,
					text: plural(count ?? issues.length, {
						one: "# field needs attention",
						other: "# fields need attention",
					}),
				});
			}
			if (!block || !focusId) return;
			const path = focusId.slice(`field-${fieldPath}.${block._key}.`.length);
			const [field = path] = path.split(".");
			const version = typeBySlug
				.get(block._type)
				?.versions.find((candidate) => candidate.version === block._version);
			const advanced = version ? planBlockFields(version.fields, "block").advanced : [];
			// Any of the block's problems may be the first on screen, so every one of them is shown.
			const inAdvanced = (slug: string) => advanced.some((candidate) => candidate.slug === slug);
			if (issues.some((issue) => issue.blockKey === block._key && inAdvanced(issue.field))) {
				setAdvancedKeys((current) => new Set(current).add(block._key));
			}
			setOpenKeys((current) => new Set(current).add(block._key));
			setRevealFocus({ key: block._key, target: "field", elementId: focusId, field });
		},
	);

	const revealToken = reveal?.token ?? 0;
	const revealFocusId = reveal?.focusId;
	const revealCount = reveal?.count;
	React.useEffect(() => {
		if (revealToken === revealTokenRef.current) return;
		revealTokenRef.current = revealToken;
		revealIssues(revealFocusId, revealCount);
	}, [revealToken, revealFocusId, revealCount, revealIssues]);

	/** Opens the block, Advanced row and list item that hold `issue`, and focuses its control. */
	const showIssue = (issue: BlockValueIssue) => {
		const block = blocks.find((candidate) => candidate._key === issue.blockKey);
		if (!block) return;
		const version = typeBySlug
			.get(block._type)
			?.versions.find((candidate) => candidate.version === block._version);
		const advanced = version ? planBlockFields(version.fields, "block").advanced : [];
		if (advanced.some((field) => field.slug === issue.field)) {
			setAdvancedKeys((current) => withKey(current, block._key));
		}
		setOpenKeys((current) => withKey(current, block._key));
		setItemReveals((current) => new Map(current).set(block._key, ++revealCountRef.current));
		setRevealFocus({
			key: block._key,
			target: "field",
			elementId: blockIssueElementId(fieldPath, issue),
			field: issue.field,
			exact: true,
		});
	};

	/** Where `element` sits in the order the field shows its problems in, if it's in a block. */
	const viewRankAt = (element: Element): number[] | undefined => {
		const key = blockKeyOf(element);
		const blockIndex = blocks.findIndex((block) => block._key === key);
		const block = blocks[blockIndex];
		if (!block) return undefined;
		const order = viewOrderOf(block, typeBySlug);
		const prefix = `field-${fieldPath}.${block._key}.`;
		for (
			let node: Element | null = element;
			node && node !== rootRef.current;
			node = node.parentElement
		) {
			if (node.id.startsWith(prefix))
				return viewRank(order, blockIndex, node.id.slice(prefix.length));
		}
		const list = element.closest<HTMLElement>("[data-block-body] [data-field]");
		const field = list?.dataset.field;
		if (!list || !field) return [blockIndex, -1];
		const item = element.closest("[data-list-item]");
		const index = item ? [...list.querySelectorAll("[data-list-item]")].indexOf(item) : -1;
		return viewRank(order, blockIndex, item ? `${field}.${index}` : field);
	};

	/** Goes to the problem after the last place in a block that had focus, or back to the first. */
	const showNextIssue = () => {
		const ranked = rankIssues([...shownIssues.values()].flat(), blocks, typeBySlug);
		const place = lastPlaceRef.current;
		const at = place?.element?.isConnected ? viewRankAt(place.element) : place?.rank;
		const next = (at && ranked.find(({ rank }) => compareRanks(rank, at) > 0)) || ranked[0];
		if (!next) return;
		lastPlaceRef.current = { rank: next.rank };
		showIssue(next.issue);
	};

	// Hands the focus over a render later, once the block, its Advanced row and any list item have opened.
	React.useEffect(() => {
		if (!revealFocus) return;
		focusRequestRef.current = revealFocus;
		setRevealFocus(null);
	}, [revealFocus]);

	React.useEffect(() => {
		const request = focusRequestRef.current;
		const root = rootRef.current;
		if (!request || !root) return;
		const focusTo = (element: HTMLElement | null, scroll: false | "nearest" | undefined) => {
			element?.focus(scroll === undefined ? undefined : { preventScroll: true });
			if (element && scroll === "nearest") bringIntoView(element);
		};
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
			focusTo(
				focusableIn(item?.querySelector("[data-item-focus]")) ?? focusableIn(item) ?? toggle,
				request.scroll,
			);
			return;
		}
		if (request.target === "field") {
			const { elementId, exact } = request;
			// The first problem on screen, rather than the first in the block type's field order.
			const firstShown = () =>
				focusableIn(
					row.querySelector("[data-block-body] [data-field-issue]:not(:has([data-field-issue]))"),
				);
			const target = () =>
				(exact ? null : firstShown()) ?? focusableIn(document.getElementById(elementId));
			const focusField = () => {
				const field = [...row.querySelectorAll<HTMLElement>("[data-block-body] [data-field]")].find(
					(element) => element.dataset.field === request.field,
				);
				(target() ?? focusableIn(field) ?? firstShown() ?? toggle)?.focus();
			};
			// A labelled Kumo input inside a list takes the id it was given only after its first render.
			if (target()) focusField();
			else requestAnimationFrame(focusField);
			return;
		}
		const control =
			request.target === "first-control"
				? focusableIn(row.querySelector("[data-block-body]"))
				: null;
		focusTo(control ?? toggle, request.scroll);
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
		// A photo's control closes its own Undo once it can't put the photo back.
		if (owner.kind === "field") return;
		const block = blocks.find((candidate) => candidate._key === owner.blockKey);
		const items = block?.[owner.field];
		if (!block || (Array.isArray(items) && items.length >= listMaxItems(block, owner.field))) {
			undo.dismiss();
		}
	});

	const openPicker = (target: PickerTarget) => {
		setPicker({ ...target, byTouch: pressRef.current === "touch" || pressRef.current === "pen" });
		setPickerOpen(true);
	};

	const insertBlock = (blockType: BlockType) => {
		if (!picker) return;
		const block = createBlockValue(blockType, createBlockKey());
		onChange(insertBlockValue(blocks, block, picker.index));
		setOpenKeys((current) => new Set(current).add(block._key));
		setArrived({ key: block._key });
		setPickerOpen(false);
		focusRequestRef.current = { key: block._key, target: "first-control", scroll: false };
	};

	const toggleBlock = (key: string) => setOpenKeys((current) => toggled(current, key));
	const toggleAdvanced = (key: string) => setAdvancedKeys((current) => toggled(current, key));

	const duplicateBlock = (index: number) => {
		const block = blocks[index];
		if (!block) return;
		const copy = duplicateBlockValue(block, createBlockKey());
		onChange(insertBlockValue(blocks, copy, index + 1));
		if (openKeys.has(block._key)) setOpenKeys((current) => new Set(current).add(copy._key));
		setArrived({ key: copy._key });
		focusRequestRef.current = { key: copy._key, target: "toggle", scroll: false };
		const name = blockLabel(block);
		setAnnouncement(t`Duplicated ${name}`);
	};

	const moveBlock = (from: number, to: number, slide = false) => {
		const block = blocks[from];
		if (!block || to < 0 || to >= blocks.length) return;
		if (slide) reorder(block._key);
		onChange(moveBlockValue(blocks, from, to));
		const name = blockLabel(block);
		const position = to + 1;
		const total = blocks.length;
		setAnnouncement(t`Moved ${name} to position ${position} of ${total}`);
	};

	const removeBlock = (key: string, placeFocus = true): number => {
		const index = blocks.findIndex((block) => block._key === key);
		if (index < 0) return index;
		const next = blocks.filter((block) => block._key !== key);
		onChange(next);
		const neighbour = next[index] ?? next[index - 1];
		if (placeFocus) {
			focusRequestRef.current = neighbour
				? { key: neighbour._key, target: "toggle" }
				: { target: "add" };
		}
		return index;
	};

	// A block put back grows in where it was, the way it shrank away.
	const restoreBlock = useStableCallback((block: StoredBlockValue, index: number) => {
		if (blocks.some((candidate) => candidate._key === block._key)) return;
		onChange(insertBlockValue(blocks, block, index));
		setArrived({ key: block._key, restored: true });
		focusRequestRef.current = { key: block._key, target: "toggle", scroll: "nearest" };
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

	const deleteBlock = (block: StoredBlockValue, hold?: DeletionHold, placeFocus?: boolean) => {
		if (readOnly) return;
		if (!canRestore(block)) {
			setConfirmDelete({ block, open: true });
			return;
		}
		const index = removeBlock(block._key, placeFocus);
		if (index < 0) return;
		const name = blockLabel(block);
		undo.offer(t`Deleted ${name}`, { kind: "block" }, () => restoreBlock(block, index), hold);
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
			moveListTouches(blockKey, field, (position) => (position < at ? position : position + 1));
			focusRequestRef.current = {
				key: blockKey,
				target: "item",
				field,
				index: at,
				scroll: "nearest",
			};
		},
	);

	const offerItemUndo = (blockKey: string, field: string, deleted: DeletedListItem) => {
		const name = deleted.name;
		undo.offer(
			t`Deleted ${name}`,
			{ kind: "item", blockKey, field },
			() => restoreListItem(blockKey, field, deleted),
			deleted.hold,
		);
	};

	const blockKeys = blocks.map((block) => block._key);
	const drag = useDragAnnouncements({
		keys: blockKeys,
		nameOf: (key) => {
			const block = blocks.find((candidate) => candidate._key === key);
			return block ? blockLabel(block) : "";
		},
		announce: setAnnouncement,
		onMove: (from, to) => onChange(moveBlockValue(blocks, from, to)),
	});

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
				ROW_BUTTON,
				"h-10 w-full justify-start gap-2 rounded-none px-2 font-normal text-kumo-subtle shadow-none hover:text-kumo-default aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
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
		<UndoContext value={undo}>
			<div
				id={id}
				ref={rootRef}
				data-blocks-field=""
				className="@container/blocks grid grid-cols-[minmax(0,1fr)] gap-2"
				onKeyDown={readOnly ? undefined : keepEnterInBlocks}
				onPointerDownCapture={(event) => {
					pressRef.current = event.pointerType;
				}}
				onKeyDownCapture={() => {
					pressRef.current = "keyboard";
				}}
				onFocus={(event) => {
					if (blockKeyOf(event.target) && rootRef.current?.contains(event.target)) {
						lastPlaceRef.current = { element: event.target, rank: viewRankAt(event.target) };
					}
				}}
			>
				<div className="flex min-h-7 items-center justify-between gap-3">
					<Label>{label}</Label>
					{blocks.length > 0 && !readOnly && (
						<div className="flex items-center gap-1">
							{toFix > 0 && (
								<Tooltip
									content={t`Go to the next problem`}
									render={
										<Button
											variant="ghost"
											size="sm"
											className={cn("text-kumo-danger", TOUCH_HEIGHT)}
											icon={<WarningCircle className="size-3.5" aria-hidden="true" />}
											aria-label={plural(toFix, {
												one: "# to fix. Go to the problem",
												other: "# to fix. Go to the next problem",
											})}
											onClick={showNextIssue}
										>
											{plural(toFix, { one: "# to fix", other: "# to fix" })}
										</Button>
									}
								/>
							)}
							<Button
								variant="ghost"
								size="sm"
								className={cn("text-kumo-subtle", TOUCH_HEIGHT)}
								icon={
									anyOpen ? (
										<ArrowsInSimple className="size-3.5" aria-hidden="true" />
									) : (
										<ArrowsOutSimple className="size-3.5" aria-hidden="true" />
									)
								}
								onClick={() => {
									const next = new Set(anyOpen ? [] : blocks.map((block) => block._key));
									const rows = [
										...(rootRef.current?.querySelectorAll<HTMLElement>("[data-block-key]") ?? []),
									];
									const restore = keepRowInView(
										rows,
										(row) => row.querySelector(":scope > [data-block-head]") ?? row,
									);
									// Every block opens or closes, and is laid out, before the one scroll back.
									flushSync(() => {
										setOpenKeys(next);
										setAllToggled(next);
									});
									restore();
								}}
							>
								{anyOpen ? t`Collapse all` : t`Expand all`}
							</Button>
						</div>
					)}
				</div>

				<div className="relative rounded-lg border border-kumo-line bg-kumo-base">
					{blocks.length > 0 ? (
						<DndContext sensors={sensors} collisionDetection={closestCenter} {...drag}>
							<SortableContext items={blockKeys} strategy={verticalListSortingStrategy}>
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
											instant={allToggled === openKeys}
											advancedOpen={readOnly || advancedKeys.has(block._key)}
											issues={shownIssues.get(block._key) ?? NO_ISSUES}
											revealToken={itemReveals.get(block._key) ?? 0}
											readOnly={readOnly}
											canAdd={canAdd}
											atMax={atMax}
											maxHint={maxHint}
											maxHintId={maxHintId}
											roundBottom={readOnly && index === blocks.length - 1}
											onToggle={() => toggleBlock(block._key)}
											onAdvancedToggle={() => toggleAdvanced(block._key)}
											onTouch={(path) => touchField(block._key, path)}
											onEdit={(path) => editField(block._key, path)}
											onItemDeleted={(field, deleted) => offerItemUndo(block._key, field, deleted)}
											onItemsShift={(field, moves) => {
												moveListTouches(block._key, field, (position) => moves[position] ?? -1);
												if (moves.includes(-1)) editField(block._key, field);
											}}
											onChange={(field, nextValue) =>
												onChange(updateBlockFieldValue(blocks, block._key, field, nextValue))
											}
											pickerOpen={pickerOpen && picker?.from === block._key}
											added={
												arrived?.key === block._key
													? arrived.restored
														? "restored"
														: "new"
													: undefined
											}
											deleteConfirms={!canRestore(block)}
											onAdd={(target) => openPicker({ ...target, from: block._key })}
											onDuplicate={() => duplicateBlock(index)}
											onMove={(to, slide) => moveBlock(index, to, slide)}
											onEdge={(edge) => {
												const moved = blockLabel(block);
												setAnnouncement(
													edge === "first"
														? t`${moved} is already first`
														: t`${moved} is already last`,
												);
											}}
											onDelete={(hold, placeFocus) => deleteBlock(block, hold, placeFocus)}
											renderField={renderField}
										/>
									))}
								</div>
							</SortableContext>
						</DndContext>
					) : (
						<p
							className={cn(
								"px-4 pt-6 text-center text-base text-kumo-subtle",
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
					{revealSummary && <span key={revealSummary.token}>{revealSummary.text}</span>}
				</p>

				{!readOnly && (
					<BlockTypePicker
						open={pickerOpen}
						anchor={picker?.anchor ?? null}
						side={picker?.side ?? "bottom"}
						invoker={picker?.invoker ?? null}
						openedByTouch={picker?.byTouch}
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
						if (confirmBlock && removeBlock(confirmBlock._key) >= 0) undo.supersede();
						setConfirmDelete((current) => current && { ...current, open: false });
					}}
				/>
			</div>
		</UndoContext>
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
	/** Opens or closes without motion, as Expand all and Collapse all do. */
	instant: boolean;
	advancedOpen: boolean;
	/** Problems to show in this block. */
	issues: readonly BlockValueIssue[];
	/** A new token opens the list items that hold a problem to show. */
	revealToken: number;
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
	/** Called when the value at this path inside the block changes here. */
	onEdit: (path: string) => void;
	onChange: (field: string, value: unknown) => void;
	onItemDeleted: (field: string, deleted: DeletedListItem) => void;
	onItemsShift: (field: string, moves: readonly number[]) => void;
	/** Whether the block picker this row opened is open. */
	pickerOpen: boolean;
	/**
	 * The block was just added or duplicated, and grows into place and into view, or put back by
	 * Undo, and grows in where it was.
	 */
	added?: "new" | "restored";
	/** Deleting asks first, so the row stays until that's confirmed. */
	deleteConfirms: boolean;
	onAdd: (target: PickerTarget) => void;
	onDuplicate: () => void;
	/** Moves the block; `slide` slides it and the blocks it passes into their places. */
	onMove: (to: number, slide?: boolean) => void;
	/** Called when the move keys would take the block past either end. */
	onEdge: (edge: "first" | "last") => void;
	/**
	 * Deletes the block. `hold` is the Undo hold it had while its row shrank away, and
	 * `placeFocus: false` leaves focus where it moved on to meanwhile.
	 */
	onDelete: (hold?: DeletionHold, placeFocus?: boolean) => void;
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
	instant,
	advancedOpen,
	issues,
	revealToken,
	readOnly,
	canAdd,
	atMax,
	maxHint,
	maxHintId,
	roundBottom,
	onToggle,
	onAdvancedToggle,
	onTouch,
	onEdit,
	onChange,
	onItemDeleted,
	onItemsShift,
	pickerOpen,
	added,
	deleteConfirms,
	onAdd,
	onDuplicate,
	onMove,
	onEdge,
	onDelete,
	renderField,
}: BlockRowProps) {
	const { t, i18n } = useLingui();
	const undo = React.useContext(UndoContext);
	const sortable = useSortable({
		id: block._key,
		disabled: readOnly,
		transition: prefersReducedMotion() ? null : SORT_TRANSITION,
	});
	const { listeners, transform, transition, node } = sortable;
	const drop = useDropSettle(block._key, sortable.isDragging, sortable.setNodeRef);
	const isDragging = sortable.isDragging || drop.settling;
	React.useLayoutEffect(() => {
		if (added && node.current) growRow(node.current, { reveal: added === "new" });
	}, [added, node]);
	// The head stays pinned until the fields have folded away under it.
	const [bodyShown, setBodyShown] = React.useState(open);
	if (open && !bodyShown) setBodyShown(true);
	const rowId = React.useId();
	const headRef = React.useRef<HTMLDivElement>(null);
	const handleRef = React.useRef<HTMLButtonElement>(null);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const afterMenuCloseRef = React.useRef<MenuAction | null>(null);
	/** Duplicate focuses the copy, so the closing menu leaves focus alone. */
	const keepFocusRef = React.useRef(false);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [menuFromHandle, setMenuFromHandle] = React.useState(false);
	const quietGutter = useQuietReturnFocus();
	const quietMenu = useQuietReturnFocus();

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
	const hasBadges = inactive || retired || unsupported;
	const badgesId = `${rowId}-badges`;
	const toggleDescription = [
		hasBadges && badgesId,
		showErrorDot && errorDotId,
		summary && summaryId,
	]
		.filter(Boolean)
		.join(" ");
	const badges = hasBadges && (
		<span
			id={badgesId}
			className={cn(
				"flex flex-wrap items-center justify-end gap-1 self-center",
				readOnly ? "ms-2" : "ms-auto",
			)}
		>
			{inactive && <Badge variant="secondary">{t`Inactive version`}</Badge>}
			{retired && <Badge variant="secondary">{t`Retired`}</Badge>}
			{unsupported && <Badge variant="secondary">{t`Unsupported`}</Badge>}
		</span>
	);

	const addFromMenu = (side: InsertSide) => {
		const invoker = menuFromHandle ? handleRef.current : triggerRef.current;
		afterMenuCloseRef.current = { kind: "add", side, invoker };
	};
	const commitDelete = useStableCallback((hold: DeletionHold | undefined, placeFocus: boolean) =>
		onDelete(hold, placeFocus),
	);
	const runMenuAction = useStableCallback((action: MenuAction) => {
		if (action.kind === "delete") {
			if (deleteConfirms || !node.current) {
				onDelete();
				return;
			}
			// Until the row has shrunk away, Undo calls the deletion off, and focuses the block as an
			// Undo after it does.
			let hold: DeletionHold | undefined;
			const collapse = collapseRow(
				node.current,
				(placeFocus) => commitDelete(hold, placeFocus),
				() => hold?.release(),
			);
			if (collapse) {
				hold = undo?.hold(() => {
					collapse.reverse();
					headRef.current
						?.querySelector<HTMLElement>("[data-block-toggle]")
						?.focus({ preventScroll: true });
				});
			}
			return;
		}
		if (action.kind === "duplicate") {
			onDuplicate();
			return;
		}
		if (!canAdd) return;
		const { side, invoker } = action;
		(invoker === handleRef.current ? quietGutter : quietMenu).handOff(invoker);
		onAdd({ index: side === "top" ? index : index + 1, anchor: headRef.current, side, invoker });
	});
	const moveKeys = useMoveKeys(index, count, onMove, onEdge);

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
				revealToken={revealToken}
				onItemDeleted={(deleted) => onItemDeleted(field.slug, deleted)}
				onItemDeleteStart={undo?.hold}
				onItemsShift={(moves) => onItemsShift(field.slug, moves)}
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
							onEdit={() => onEdit(path)}
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
						onEdit={(slug) => onEdit(`${field.slug}.${at}.${slug}`)}
						onChange={onItemChange}
						renderField={renderField}
					/>
				)}
			/>
		);
	};

	return (
		<div
			ref={drop.setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			role="listitem"
			data-block-key={block._key}
			data-menu-open={menuOpen || undefined}
			data-picker-open={pickerOpen || undefined}
			className={cn(
				"group/block relative [--emdash-blocks-sticky-top:var(--emdash-editor-sticky-top,0px)] focus-within:z-40",
				index > 0 && "border-t border-kumo-hairline",
				!readOnly && LIFT_SHADOW,
				isDragging && cn(DRAGGING, "z-40 rounded-lg"),
				sortable.isDragging && LIFTED,
			)}
		>
			{!readOnly && (
				<div
					className={cn(
						"absolute end-full top-2.5 hidden items-center pe-1 blocks-gutter:flex",
						REVEAL_GUTTER,
					)}
					{...quietGutter.groupProps}
				>
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
								className={cn(
									ROW_BUTTON,
									"size-6 text-kumo-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
								)}
								// The gutter is for the pointer. The keyboard reaches the same actions in the menu.
								tabIndex={-1}
								aria-label={t`Add block below ${label}`}
								aria-haspopup="dialog"
								aria-disabled={!canAdd || undefined}
								aria-describedby={atMax ? maxHintId : undefined}
								onClick={(event) => {
									if (!canAdd) return;
									quietGutter.markOpener(event);
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
								className={cn(ROW_BUTTON, "h-6 w-[1.125rem] touch-none text-kumo-subtle")}
								tabIndex={-1}
								aria-label={t`Reorder ${blockType?.label ?? block._type}`}
								aria-haspopup="menu"
								aria-expanded={menuOpen && menuFromHandle}
								{...listeners}
								onClick={(event) => {
									quietGutter.markOpener(event);
									keepFocusRef.current = false;
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
				data-block-head
				className={cn(
					// The toggle fills the head's height and its width up to the menu, padding included, so a
					// click anywhere the row washes before its menu opens it.
					"flex min-h-11 items-stretch pe-2.5",
					!readOnly && cn(ROW_HOVER, HEAD_POPUP_OPEN, HEAD_PRESSED),
					!readOnly && HEAD_FOCUS,
					index === 0 && SHEET_INNER_TOP,
					roundBottom && !open && SHEET_INNER_BOTTOM,
					(open || bodyShown) &&
						"sticky top-(--emdash-blocks-sticky-top) z-30 bg-kumo-base shadow-[inset_0_-1px_0_var(--color-kumo-hairline)]",
				)}
			>
				{readOnly ? (
					<div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 ps-8">
						<BlockTypeIcon
							name={blockType?.icon}
							className={cn("size-4 shrink-0 text-kumo-subtle", GLYPH_NUDGE)}
						/>
						<span id={labelId} dir="auto" className={cn(BLOCK_TITLE, "min-w-0 wrap-anywhere")}>
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
						aria-keyshortcuts={MOVE_KEYS}
						onClick={onToggle}
						onKeyDown={moveKeys}
						className="flex min-w-0 flex-1 items-center gap-2 py-1.5 ps-2 pe-2 text-start outline-none"
					>
						<DisclosureCaret open={open} instant={instant} className={GLYPH_NUDGE} />
						<BlockTypeIcon
							name={blockType?.icon}
							className={cn("size-4 shrink-0 text-kumo-subtle", GLYPH_NUDGE)}
						/>
						<span id={labelId} dir="auto" className={cn(BLOCK_TITLE, "min-w-0 wrap-anywhere")}>
							{label}
						</span>
						{summary && (
							<span
								className={cn(
									ROW_SUMMARY,
									SUMMARY_SLOT,
									"transition-opacity duration-150 ease-emdash motion-reduce:transition-none",
									open && "opacity-0",
									instant && "transition-none",
								)}
							>
								<span id={summaryId} dir="auto" className={SUMMARY_TEXT}>
									{summary}
								</span>
							</span>
						)}
						{thumbnail && (
							<img
								key={thumbnail}
								src={thumbnail}
								alt=""
								loading="lazy"
								className={cn(
									IMAGE_EDGE,
									"size-7 shrink-0 rounded-md object-cover transition-opacity duration-150 ease-emdash motion-reduce:transition-none",
									open && "opacity-0",
									instant && "transition-none",
								)}
								onError={(event) => {
									event.currentTarget.hidden = true;
								}}
							/>
						)}
						{showErrorDot && <ErrorDot id={errorDotId} />}
						{badges}
					</button>
				)}
				{readOnly && badges}
				{!readOnly && (
					<DropdownMenu
						open={menuOpen}
						onOpenChange={(next) => {
							if (next) {
								setMenuFromHandle(false);
								keepFocusRef.current = false;
							}
							setMenuOpen(next);
						}}
						onOpenChangeComplete={(isOpen) => {
							if (isOpen) return;
							const after = afterMenuCloseRef.current;
							afterMenuCloseRef.current = null;
							if (after) runMenuAction(after);
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
									className={cn(
										ROW_BUTTON,
										"shrink-0 self-center text-kumo-subtle",
										REVEAL_MENU,
										TOUCH_TARGET,
									)}
									aria-label={t`${label} actions`}
									// The menu shows the version. Only an older one is worth saying before it opens.
									aria-describedby={inactive ? versionId : undefined}
									aria-keyshortcuts={MOVE_KEYS}
									{...quietMenu.groupProps}
									onClick={quietMenu.markOpener}
									onKeyDown={(event) => {
										quietMenu.groupProps.onKeyDown(event);
										moveKeys(event);
									}}
								>
									<DotsThree className="size-4" weight="bold" aria-hidden="true" />
								</Button>
							}
						/>
						<DropdownMenu.Portal>
							<DropdownMenu.Positioner
								anchor={menuFromHandle ? handleRef : undefined}
								align={menuFromHandle ? "start" : "end"}
							>
								<DropdownMenu.Popup
									className={cn("min-w-56", POPUP_MOTION, MENU_TOUCH)}
									finalFocus={() =>
										!keepFocusRef.current && ((menuFromHandle && handleRef.current) || true)
									}
								>
									<RowMenuItems
										index={index}
										count={count}
										add={{
											above: t`Add block above`,
											below: t`Add block below`,
											disabled: !canAdd,
											onSelect: (side) => addFromMenu(side === "above" ? "top" : "bottom"),
										}}
										duplicate={{
											disabled: retired || unsupported || inactive || atMax,
											onSelect: () => {
												afterMenuCloseRef.current = { kind: "duplicate" };
												keepFocusRef.current = true;
											},
										}}
										onMove={onMove}
										onDelete={() => {
											afterMenuCloseRef.current = { kind: "delete" };
										}}
									/>
									<DropdownMenu.Separator />
									<div className="grid gap-0.5 px-2 py-1 text-xs text-kumo-subtle">
										<span>{t`${label} · version ${versionNumber}`}</span>
										{atMax && <span>{maxHint}</span>}
									</div>
								</DropdownMenu.Popup>
							</DropdownMenu.Positioner>
						</DropdownMenu.Portal>
					</DropdownMenu>
				)}
				{!readOnly && inactive && (
					<span id={versionId} hidden>
						{t`Version ${block._version}`}
					</span>
				)}
			</div>

			<DisclosurePanel
				open={open}
				instant={instant}
				headRef={headRef}
				onClosed={() => setBodyShown(false)}
				id={bodyId}
				data-block-body
				role="group"
				aria-labelledby={labelId}
				className="[--emdash-editor-sticky-top:calc(var(--emdash-blocks-sticky-top)+2.75rem)]"
			>
				<div className="px-2 pt-2 pb-5 @min-[440px]/blocks:px-12">
					{unsupported || !version ? (
						<p className="ps-2 text-base text-kumo-subtle">
							{t`This block cannot be edited because its stored definition is unavailable.`}
						</p>
					) : (
						<BlockFields
							scope="block"
							fields={version.fields}
							values={block}
							namePrefix={blockPath}
							blockLabel={label}
							describe={(field) =>
								nestedDescriptor(field, block, `${outerId}:${block._key}:${field.slug}`)
							}
							issueAt={issueAt}
							advancedOpen={advancedOpen}
							onAdvancedToggle={onAdvancedToggle}
							onTouch={onTouch}
							onEdit={onEdit}
							onChange={onChange}
							renderField={renderField}
							renderList={renderList}
						/>
					)}
				</div>
			</DisclosurePanel>
		</div>
	);
}

interface ControlOptions {
	/** Replaces every other placeholder, as the two halves of a button row do. */
	placeholder?: string;
	/** Shown in an empty optional field. */
	emptyPlaceholder?: string;
	heading?: boolean;
	/** Draws a photo as a thumbnail in a settings row. */
	thumbnail?: "row";
	/** A table cell, which has no room under it: shows no count, and draws a photo as a thumbnail. */
	cell?: boolean;
	/**
	 * The label's line that says what the control has to say, and which of its controls this one is.
	 * Without one, the control says it at the end of its own line.
	 */
	noteSource?: NoteSource;
	/**
	 * A settings row's control. Beside its label it says what it has to say at the end of its own
	 * line, or for a problem with no room there, on a line of its own under the row's values.
	 * Stacked under its label, it says it on the label's line. Empty and required, it says so with
	 * its placeholder either way.
	 */
	side?: boolean;
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
	/** Called when the control changes its value, unless it only swaps one empty value for another. */
	onEdit: () => void;
	renderField: BlocksFieldProps["renderField"];
}

let measuring: CanvasRenderingContext2D | null | undefined;

/** How wide `text` runs in the font `element` draws its text in. */
function textWidth(text: string, element: Element): number {
	measuring ??= document.createElement("canvas").getContext("2d");
	if (!measuring) return 0;
	measuring.font = getComputedStyle(element).font;
	return measuring.measureText(text).width;
}

/** The space kept between a control's text and the note at the end of its line, and past the note. */
const NOTE_ROOM = 16;

/**
 * How far into the line of the control in `wrapper` its own text, or failing that its buttons,
 * reach from the line's start edge, and how wide the line is.
 */
function lineUse(wrapper: HTMLElement): { used: number; width: number } | null {
	const control = wrapper.querySelector<HTMLElement>("input, [role=combobox]");
	if (control) {
		const text =
			control instanceof HTMLInputElement
				? control.value || control.placeholder
				: (control.textContent ?? "");
		const start = Number.parseFloat(getComputedStyle(control).paddingInlineStart) || 0;
		return { used: start + textWidth(text, control), width: control.clientWidth };
	}
	const content = wrapper.firstElementChild;
	if (!content) return null;
	const line = wrapper.getBoundingClientRect();
	const rtl = getComputedStyle(wrapper).direction === "rtl";
	let used = 0;
	for (const child of content.children) {
		const box = child.getBoundingClientRect();
		if (box.width > 0) used = Math.max(used, rtl ? line.right - box.left : box.right - line.left);
	}
	return { used, width: wrapper.clientWidth };
}

/**
 * A field's quiet control. What it has to say (its problem, and while it has focus its count) goes
 * on its label's line, or at the end of its own line when it has no label line or sits beside its
 * label, so none of it moves or covers anything. Beside its label, a problem with no room there
 * goes on a line of its own under the control once focus has left, and stays there while the
 * control has focus again.
 */
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
	noteSource,
	side = false,
	dataField,
	onChange,
	onTouch,
	onEdit,
	renderField,
}: FieldControlProps) {
	const issueMessage = useIssueMessage();
	const controlNotes = useControlNotes();
	const id = `field-${name}`;
	const onLabelLine = noteSource !== undefined && !side;
	const notes = controlNotes({
		field,
		id,
		value,
		issue,
		placeholder: placeholderOverride,
		emptyPlaceholder,
		onLabelLine,
		cell,
	});
	const errorId = `${id}-error`;
	const error = issue ? issueMessage(issue, { link: isLinkField(field) }) : undefined;
	const describedBy =
		[error && errorId, notes.counted && notes.countSlotId].filter(Boolean).join(" ") || undefined;
	const [focused, setFocused] = React.useState(false);
	// Focus left by a press is handled once its click lands, which can move this control to
	// another place in its list.
	const touch = useStableCallback(onTouch);
	const wrapperRef = React.useRef<HTMLDivElement>(null);
	const noteRef = React.useRef<HTMLSpanElement>(null);
	const ownNote = !onLabelLine && Boolean(notes.message || notes.countSlotId);
	/** Whether the problem fits at the end of the control's line beside its text. */
	const [messageFits, setMessageFits] = React.useState(true);
	/**
	 * The problem shows on a line of its own, which keeps its place while the control has focus. The
	 * line comes at once with the control, and after that grows in and shrinks away, so the rows
	 * below glide rather than jump.
	 */
	const [below, setBelow] = React.useState({ shown: false, instant: true });
	const placedRef = React.useRef(false);
	const placeProblem = (shown: boolean) => {
		const instant = !placedRef.current;
		placedRef.current = true;
		setBelow((current) => (current.shown === shown ? current : { shown, instant }));
	};
	// The note at the end of the control's line keeps its text from running under it.
	React.useLayoutEffect(() => {
		const note = noteRef.current;
		const wrapper = wrapperRef.current;
		if (!note || !wrapper || typeof ResizeObserver === "undefined") return;
		const reserve = () => {
			const width = note.getBoundingClientRect().width;
			wrapper.style.setProperty("--emdash-note-end", `${width > 0 ? width + 8 : 0}px`);
		};
		reserve();
		const observer = new ResizeObserver(reserve);
		observer.observe(note);
		return () => observer.disconnect();
	}, [ownNote]);
	// A note at the end of the control's line shows only where it fits beside the control's text,
	// rather than cutting short both.
	const measureNote = useStableCallback(() => {
		const note = noteRef.current;
		const wrapper = wrapperRef.current;
		if (!ownNote || !note || !wrapper) return;
		if (!focused && !notes.message) {
			placeProblem(false);
			return;
		}
		const line = lineUse(wrapper);
		if (!line) return;
		const fits = (text: string) => {
			const width = textWidth(text, note);
			return line.used + width + NOTE_ROOM <= line.width && width <= wrapper.clientWidth * 0.6;
		};
		const fitsNow = !notes.message || fits(notes.message);
		setMessageFits(fitsNow);
		if (side && !focused) placeProblem(!fitsNow);
	});
	React.useLayoutEffect(
		() => measureNote(),
		[ownNote, focused, side, notes.message, value, measureNote],
	);
	// The room beside the control's text changes with its line's width.
	React.useLayoutEffect(() => {
		const wrapper = wrapperRef.current;
		if (!ownNote || !wrapper || typeof ResizeObserver === "undefined") return;
		let width = wrapper.clientWidth;
		const observer = new ResizeObserver(() => {
			if (wrapper.clientWidth === width) return;
			width = wrapper.clientWidth;
			measureNote();
		});
		observer.observe(wrapper);
		return () => observer.disconnect();
	}, [ownNote, measureNote]);
	// The line keeps its last problem while it shrinks away, rather than going blank first.
	const [lineMessage, setLineMessage] = React.useState(notes.message);
	if (notes.message && notes.message !== lineMessage) setLineMessage(notes.message);
	const endMessage =
		notes.message && !below.shown ? (messageFits ? notes.message : notes.briefMessage) : undefined;
	const change = (next: unknown) => {
		if (!isEmptyValue(value) || !isEmptyValue(next)) onEdit();
		onChange(next);
	};
	const offerRestore = usePhotoUndo(field.label, isEmptyValue(value), change);
	return (
		<>
			<div
				ref={wrapperRef}
				data-field={dataField}
				data-field-issue={issue ? "" : undefined}
				data-note={noteSource}
				className={cn(
					"group/control relative min-w-0",
					notes.placeholderSays && "[&_:is(input,textarea)]:placeholder:text-kumo-subtle!",
					// The note sits at the field's end, which is a control's own end only while its text
					// runs the field's way.
					ownNote &&
						"ltr:[&_:is(input,[role=combobox])]:pr-[calc(0.5rem+var(--emdash-note-end,0px))]! rtl:[&_:is(input,[role=combobox])]:pl-[calc(0.5rem+var(--emdash-note-end,0px))]!",
				)}
				onFocus={ownNote ? () => setFocused(true) : undefined}
				onBlur={onFocusLeave(() => {
					setFocused(false);
					touch();
				})}
			>
				<ImageRemovalContext value={field.type === "image" ? offerRestore : null}>
					{renderField({
						name,
						field: descriptor,
						value,
						onChange: change,
						chrome: {
							labelledBy,
							describedBy,
							placeholder: notes.placeholder,
							placeholderSays: notes.placeholderSays,
							invalid: issue !== undefined,
							emptyIssue: notes.emptyIssue,
							countSlotId: notes.countSlotId,
							heading,
							thumbnail: cell ? "cell" : thumbnail,
						},
					})}
				</ImageRemovalContext>
				{ownNote && (
					<span
						ref={noteRef}
						aria-hidden="true"
						className={cn(
							NOTE,
							"pointer-events-none absolute end-2 top-0 h-8 max-w-[60%] items-center gap-x-1.5",
							// Stacked under its label, a settings row's control leaves its notes to the label's line.
							!endMessage && !focused
								? "hidden"
								: side
									? "hidden @min-[440px]/blocks:flex"
									: "flex",
						)}
					>
						{endMessage && (
							<span dir="auto" className="min-w-0 truncate text-kumo-danger">
								{endMessage}
							</span>
						)}
						{notes.countSlotId && (
							<span
								id={notes.countSlotId}
								data-count-slot={notes.countSlotId}
								className={cn(
									"shrink-0 text-kumo-subtle tabular-nums empty:hidden",
									focused ? NOTE_ON_FOCUS : "hidden",
								)}
							/>
						)}
					</span>
				)}
				{error && (
					<p id={errorId} hidden>
						{error}
					</p>
				)}
			</div>
			{side && (
				<DisclosurePanel
					open={below.shown}
					instant={below.instant}
					aria-hidden="true"
					className={cn(
						"hidden @min-[440px]/blocks:block",
						// Under a button row's two halves, the line spans both.
						noteSource === "field" ? "@min-[440px]/blocks:col-start-2" : "col-span-full",
					)}
				>
					<p className={cn(NOTE, "min-h-5 ps-2 pb-1 wrap-anywhere text-kumo-danger")}>
						{/* A fixed problem fades out at once; its line keeps its height until focus leaves. */}
						<span
							dir="auto"
							className={cn(
								"transition-opacity duration-150 ease-emdash motion-reduce:transition-none",
								!notes.message && "opacity-0",
							)}
						>
							{notes.message || lineMessage}
						</span>
					</p>
				</DisclosurePanel>
			)}
		</>
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
	/** The block's name, which names its Advanced row. */
	blockLabel?: string;
	advancedOpen?: boolean;
	onAdvancedToggle?: () => void;
	/** Called when focus leaves the control of the field with this slug. */
	onTouch: (slug: string) => void;
	/** Called when the control of the field with this slug changes its value. */
	onEdit: (slug: string) => void;
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
	blockLabel,
	advancedOpen = false,
	onAdvancedToggle,
	onTouch,
	onEdit,
	onChange,
	renderField,
	renderList,
}: BlockFieldsProps) {
	const { t } = useLingui();
	const controlNotes = useControlNotes();
	const plan = React.useMemo(() => planBlockFields(fields, scope), [fields, scope]);
	const advancedId = React.useId();
	const advancedSummaryId = `${advancedId}-summary`;
	const advancedDotId = `${advancedId}-dot`;
	const touch = useStableCallback(onTouch);

	if (fields.length === 0) {
		return scope === "block" ? (
			<p className="ps-2 text-base text-kumo-subtle">{t`This block has no fields.`}</p>
		) : null;
	}

	const controlId = (field: LayoutFieldDefinition) => `field-${namePrefix}.${field.slug}`;
	const labelId = (field: LayoutFieldDefinition) => `${controlId(field)}-label`;
	/** What the control of `field` has to say on its label's line. */
	const notesOf = (
		field: LayoutFieldDefinition,
		{
			source = "field",
			placeholder,
			side = false,
		}: { source?: NoteSource; placeholder?: string; side?: boolean } = {},
	): NotedControl => ({
		source,
		...controlNotes({
			field,
			id: controlId(field),
			value: values[field.slug],
			issue: issueAt(field.slug),
			placeholder,
			onLabelLine: !side,
		}),
	});

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
					data-field-issue={issueAt(field.slug) ? "" : undefined}
					className="min-w-0"
					onBlur={onFocusLeave(() => touch(field.slug))}
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
				onEdit={() => onEdit(field.slug)}
				renderField={renderField}
			/>
		);
	};

	const stacked = (field: LayoutFieldDefinition, heading?: boolean) => {
		if (field.type === "repeater") return control(field, labelId(field));
		return (
			<NotedField
				key={field.slug}
				className="grid min-w-0"
				label={{
					id: labelId(field),
					htmlFor: controlId(field),
					className: FIELD_LABEL,
					text: field.label,
					controls: [notesOf(field)],
				}}
			>
				{control(field, labelId(field), { heading, noteSource: "field" })}
			</NotedField>
		);
	};

	const settingRow = (field: LayoutFieldDefinition) => (
		<NotedField
			key={field.slug}
			side
			className={SETTING_ROW}
			label={
				field.type === "image"
					? {
							as: "span",
							id: labelId(field),
							// Stacked over a thumbnail, which has no padding of its own, the label keeps a photo's gap.
							className: cn(SETTING_LABEL, "pb-1.5"),
							text: field.label,
							controls: [notesOf(field, { side: true })],
						}
					: {
							id: labelId(field),
							htmlFor: controlId(field),
							className: SETTING_LABEL,
							text: field.label,
							controls: [notesOf(field, { side: true })],
						}
			}
		>
			{control(field, labelId(field), {
				...(field.type === "image" ? { thumbnail: "row" } : {}),
				noteSource: "field",
				side: true,
			})}
		</NotedField>
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
							"grid min-w-0 gap-x-2",
							FIELD_GAP[scope],
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
					<NotedField
						key={part.field.slug}
						className="grid min-w-0 gap-y-0.5"
						label={{
							as: "span",
							id: labelId(part.field),
							className: cn(FIELD_LABEL, "pb-1"),
							text: part.field.label,
							controls: [notesOf(part.field)],
						}}
					>
						{control(part.field, labelId(part.field), { noteSource: "field" })}
						{caption && (
							<>
								<span id={labelId(caption)} hidden>
									{caption.label}
								</span>
								{control(caption, labelId(caption), { emptyPlaceholder: t`Add a caption` })}
							</>
						)}
					</NotedField>
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
		const textPlaceholder = t`Text`;
		const linkPlaceholder = t`Link`;
		return (
			<NotedField
				key={part.text.slug}
				side
				className={SETTING_ROW}
				groupProps={{ role: "group", "aria-labelledby": rowLabelId }}
				label={{
					id: rowLabelId,
					htmlFor: controlId(part.text),
					className: SETTING_LABEL,
					text: part.label,
					controls: [
						notesOf(part.text, { source: "text", placeholder: textPlaceholder, side: true }),
						notesOf(part.link, { source: "link", placeholder: linkPlaceholder, side: true }),
					],
				}}
			>
				<div className="grid min-w-0 grid-flow-row-dense grid-cols-2 items-start gap-x-2">
					<span id={labelId(part.text)} hidden>
						{part.text.label}
					</span>
					{control(part.text, labelId(part.text), {
						placeholder: textPlaceholder,
						noteSource: "text",
						side: true,
					})}
					<span id={labelId(part.link)} hidden>
						{part.link.label}
					</span>
					{control(part.link, labelId(part.link), {
						placeholder: linkPlaceholder,
						noteSource: "link",
						side: true,
					})}
				</div>
			</NotedField>
		);
	};

	const advancedSummary = plan.advanced
		.flatMap((field) => {
			const value = values[field.slug];
			if (typeof value !== "string" || value.trim() === "") return [];
			const label = field.label;
			return [t`${label}: ${value}`];
		})
		.join(" · ");

	const hasContent = plan.content.length > 0;
	const hasSettings = plan.settings.length + plan.advanced.length > 0;
	const lastContent = plan.content.at(-1);
	const photoEndsContent = lastContent?.kind === "image" && !lastContent.caption;
	const settingsRule = hasContent && plan.settings.length > 0 && scope === "block";
	const advancedIssue = plan.advanced.some((field) => issueAt(field.slug));
	return (
		<>
			{hasContent && (
				<div className={cn("grid", FIELD_GAP[scope])}>{plan.content.map(contentPart)}</div>
			)}
			{settingsRule && (
				<div
					className={cn(
						"mx-2 my-2.5 border-t border-kumo-hairline",
						// A caption's text sits inside its control, but a photo's edge is its own box, as a
						// stacked label's text is, so under a photo a stacked zone's rule takes more room.
						photoEndsContent && "my-3.5 @min-[440px]/blocks:my-2.5",
					)}
				/>
			)}
			{/* Below 440px settings rows stack like the fields above them, so they're spaced like fields. */}
			{hasSettings && (
				<div
					className={cn(
						"grid @min-[440px]/blocks:gap-y-0.5",
						FIELD_GAP[scope],
						hasContent && scope === "item" && "mt-3 @min-[440px]/blocks:mt-2",
						hasContent && scope === "block" && !settingsRule && "mt-5",
					)}
				>
					{plan.settings.map(settingPart)}
					{plan.advanced.length > 0 && (
						// Advanced's text sits in the middle of its row, so after stacked rows it comes closer by
						// as much, to keep the field gap.
						<div className={cn(plan.settings.length > 0 && "-mt-2 @min-[440px]/blocks:mt-1")}>
							<button
								type="button"
								aria-expanded={advancedOpen}
								aria-controls={advancedId}
								aria-label={blockLabel ? t`Advanced: ${blockLabel}` : undefined}
								aria-describedby={
									[
										!advancedOpen && advancedSummary && advancedSummaryId,
										!advancedOpen && advancedIssue && advancedDotId,
									]
										.filter(Boolean)
										.join(" ") || undefined
								}
								onClick={onAdvancedToggle}
								className={cn(
									LABEL,
									SIDE_LABEL_TEXT,
									ROW_HOVER,
									"flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-start outline-none focus-visible:ring-1 focus-visible:ring-kumo-focus/50 focus-visible:ring-inset",
								)}
							>
								<span className="shrink-0">{t`Advanced`}</span>
								{/* A caret between two texts would read as a path, so it ends the row. */}
								{!advancedOpen && advancedSummary && (
									<span className="flex min-w-0 items-baseline gap-1.5 font-normal text-kumo-subtle">
										{NOTE_DOT}
										<span id={advancedSummaryId} dir="auto" className="min-w-0 truncate">
											{advancedSummary}
										</span>
									</span>
								)}
								{!advancedOpen && advancedIssue && <ErrorDot id={advancedDotId} />}
								{/* Below 440px the label is 12px, beside which a caret needs no nudge. */}
								<DisclosureCaret
									open={advancedOpen}
									className="@min-[440px]/blocks:translate-y-px"
								/>
							</button>
							<DisclosurePanel open={advancedOpen} id={advancedId}>
								<div
									className={cn(
										"grid pt-2 @min-[440px]/blocks:gap-y-0.5 @min-[440px]/blocks:pt-0.5",
										FIELD_GAP.block,
									)}
								>
									{plan.advanced.map(settingRow)}
								</div>
							</DisclosurePanel>
						</div>
					)}
				</div>
			)}
		</>
	);
}
