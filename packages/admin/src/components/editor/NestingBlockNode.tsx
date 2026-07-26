/**
 * Nesting Block Node for TipTap
 *
 * A grid/flex layout container built from explicit `nestingColumn` cells. The
 * container (`nestingBlock`) holds `nestingColumn+`, each column holds `block+`
 * (its own editable blocks). Columns pre-exist as bordered drop zones, editors
 * add/remove columns with toolbar controls and type into each independently
 * rather than relying on Enter to spawn cells.
 *
 * Serializes to a Portable Text `nestingBlock` whose `children` is an array of
 * `nestingColumn` objects (each with its own `children` blocks); the PT to/from PM
 * converters in @emdash-cms/core and the admin editor handle the round-trip.
 */

import { Button, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, CaretRight, Plus, Rows, SquaresFour, Trash, X } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

type NestingLayout = "grid" | "flex";
type NestingGap = "none" | "sm" | "md" | "lg";
type NestingAlign = "start" | "center" | "end" | "stretch";
type NestingWidths = "equal" | "wide-first" | "wide-last" | "narrow-first" | "narrow-last";
const NESTING_WIDTHS = new Set<string>([
	"equal",
	"wide-first",
	"wide-last",
	"narrow-first",
	"narrow-last",
]);

const DEFAULTS = {
	widths: "equal" as NestingWidths,
	layout: "grid" as NestingLayout,
	gap: "md" as NestingGap,
	align: "start" as NestingAlign,
};

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;

/**
 * Width reserved inside every row of a column for its drag handle, wide enough for
 * the handle cluster plus a small gap. Exported so the drag handle can offset itself
 * into it -- the two numbers have to agree or the handle lands on the row's content.
 */
export const NESTING_GUTTER_PX = 52;

/** CSS gap value per named size. */
const GAP_TO_CSS: Record<NestingGap, string> = {
	none: "0",
	sm: "0.5rem",
	md: "1rem",
	lg: "2rem",
};

/**
 * TipTap's React `NodeViewContent` nests children one level deeper inside a
 * `[data-node-view-content-react]` wrapper, so the layout must target that
 * wrapper, not the element we render. Layout is passed as CSS variables and
 * applied here, column cells get the border and sizing.
 */
const STYLE_ID = "emdash-nesting-block-style";
const NESTING_STYLES = `
.nesting-column-content > [data-node-view-content-react] {
	--nesting-gutter: ${NESTING_GUTTER_PX}px;
}
.nesting-block-content > [data-node-view-content-react] {
	display: var(--nesting-display, grid);
	grid-template-columns: var(--nesting-cols, repeat(2, minmax(0, 1fr)));
	gap: var(--nesting-gap, 1rem);
	align-items: var(--nesting-align, start);
	flex-wrap: wrap;
}
.nesting-column {
	flex: 1 1 12rem;
	min-width: 0;
}
.nesting-column-content {
	min-height: 2.5rem;
}
/*
 * The drag handle's gutter belongs to each row, not to the column.
 *
 * Padding the column instead would put the gutter outside every row's box, so a
 * pointer there resolves to the column, which is never a drag target, and the
 * container wins instead. In use that reads as the handle jumping away exactly
 * as you reach for it. Owning the padding keeps a pointer in the gutter inside
 * the row it belongs to.
 */
.nesting-column-content > [data-node-view-content-react] > * {
	padding-inline-start: var(--nesting-gutter);
}
/*
 * A row that indents its own content keeps that indent on top of the gutter.
 * Setting the gutter alone replaces it, which pulls list markers and a quote's
 * rule back into the gutter and leaves them under the drag handle. The added
 * values are the editor's own defaults for these elements.
 */
.nesting-column-content > [data-node-view-content-react] > :is(ul, ol) {
	padding-inline-start: calc(var(--nesting-gutter) + 1.625rem);
}
.nesting-column-content > [data-node-view-content-react] > blockquote {
	padding-inline-start: calc(var(--nesting-gutter) + 1rem);
}
.nesting-column-content > [data-node-view-content-react] > *:first-child {
	margin-top: 0;
}
.nesting-column-content > [data-node-view-content-react] > *:last-child {
	margin-bottom: 0;
}
`;

function ensureNestingStyles(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = NESTING_STYLES;
	document.head.appendChild(style);
}

/**
 * `grid-template-columns` for a width preset. Mirrors `nestingTemplateColumns`
 * in @emdash-cms/core so the editor preview matches what the site renders; the
 * admin does not depend on core, hence the duplication (as with GAP_TO_CSS).
 */
function templateColumns(widths: NestingWidths, columnCount: number): string {
	const n = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, columnCount));
	if (widths === "equal" || n < 2) return `repeat(${n}, minmax(0, 1fr))`;
	const weightedIndex = widths === "wide-first" || widths === "narrow-last" ? 0 : n - 1;
	return Array.from({ length: n }, (_, i) =>
		i === weightedIndex ? "minmax(0, 2fr)" : "minmax(0, 1fr)",
	).join(" ");
}

function containerVars(
	layout: NestingLayout,
	columnCount: number,
	gap: NestingGap,
	align: NestingAlign,
	widths: NestingWidths,
): React.CSSProperties {
	return {
		"--nesting-display": layout === "grid" ? "grid" : "flex",
		"--nesting-cols": templateColumns(widths, columnCount),
		"--nesting-gap": GAP_TO_CSS[gap],
		"--nesting-align": align,
	} as React.CSSProperties;
}

// Column node

function NestingColumnNodeView({ editor, getPos, node }: NodeViewProps) {
	const { t } = useLingui();

	const canRemove = React.useMemo(() => {
		if (typeof getPos !== "function") return false;
		const pos = getPos();
		if (typeof pos !== "number") return false;
		try {
			return editor.state.doc.resolve(pos).parent.childCount > 1;
		} catch {
			return false;
		}
	}, [editor, getPos, node]);

	const removeColumn = () => {
		if (typeof getPos !== "function") return;
		const pos = getPos();
		if (typeof pos !== "number") return;
		editor
			.chain()
			.focus()
			.deleteRange({ from: pos, to: pos + node.nodeSize })
			.run();
	};

	return (
		<NodeViewWrapper
			// The drag handle's gutter is padded onto each row rather than onto the column
			// -- see NESTING_STYLES for why.
			className="nesting-column group/col relative rounded-md border border-kumo-line p-2"
			data-emdash-nesting-column
		>
			{canRemove && (
				<Button
					type="button"
					variant="ghost"
					shape="square"
					className="absolute -end-2 -top-2 z-10 h-6 w-6 rounded-full border border-kumo-line bg-kumo-base opacity-0 transition-opacity group-hover/col:opacity-100"
					onClick={removeColumn}
					title={t`Remove column`}
					aria-label={t`Remove column`}
					contentEditable={false}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			)}
			<NodeViewContent className="nesting-column-content" />
		</NodeViewWrapper>
	);
}

export const NestingColumnExtension = Node.create({
	name: "nestingColumn",
	group: "nestingColumn",
	content: "block+",
	isolating: true,
	selectable: false,

	parseHTML() {
		return [{ tag: "div[data-emdash-nesting-column]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-emdash-nesting-column": "" }), 0];
	},

	addNodeView() {
		return ReactNodeViewRenderer(NestingColumnNodeView);
	},
});

// Container node

function NestingBlockNodeView({
	node,
	updateAttributes,
	selected,
	deleteNode,
	editor,
	getPos,
}: NodeViewProps) {
	const { t } = useLingui();

	React.useEffect(() => {
		ensureNestingStyles();
	}, []);

	const layout: NestingLayout = node.attrs.layout === "flex" ? "flex" : "grid";
	const widths: NestingWidths =
		typeof node.attrs.widths === "string" && NESTING_WIDTHS.has(node.attrs.widths)
			? (node.attrs.widths as NestingWidths)
			: DEFAULTS.widths;
	const gap: NestingGap = (["none", "sm", "md", "lg"] as const).includes(node.attrs.gap)
		? node.attrs.gap
		: DEFAULTS.gap;
	const align: NestingAlign = (["start", "center", "end", "stretch"] as const).includes(
		node.attrs.align,
	)
		? node.attrs.align
		: DEFAULTS.align;

	const columnCount = node.childCount;

	/**
	 * Collapsed is view state, not content: it is deliberately not a node attribute,
	 * so folding a container away is never a document change and never lands in a
	 * revision. It resets on reload, which matches how editors expect a disclosure to
	 * behave.
	 */
	const [collapsed, setCollapsed] = React.useState(false);

	// Ties the disclosure button to the region it shows and hides.
	const contentId = React.useId();

	// What the container holds, for the summary shown when it is folded away.
	const blockCount = React.useMemo(() => {
		let total = 0;
		node.forEach((column) => {
			total += column.childCount;
		});
		return total;
	}, [node]);

	const addColumn = () => {
		if (typeof getPos !== "function" || columnCount >= MAX_COLUMNS) return;
		const pos = getPos();
		if (typeof pos !== "number") return;
		const endInside = pos + node.nodeSize - 1;
		editor
			.chain()
			.focus()
			.insertContentAt(endInside, { type: "nestingColumn", content: [{ type: "paragraph" }] })
			.run();
	};

	return (
		<NodeViewWrapper
			className={cn(
				"nesting-block relative my-3 rounded-lg border transition-colors",
				selected ? "border-kumo-brand/50 bg-kumo-tint/20" : "border-kumo-line",
			)}
		>
			<div
				className="flex flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2"
				contentEditable={false}
			>
				{/* The title is the grab area, the way a window is dragged by its bar. There
				    was a separate grip here, permanently visible, which nothing else in the
				    editor has: every other row is dragged from a handle that appears in the
				    gutter on hover. A container is a row too, but hovering one resolves to
				    the deepest row inside it, so it still needs somewhere of its own to be
				    picked up -- its header, rather than an icon that is always on screen. */}
				<Button
					type="button"
					variant="ghost"
					shape="square"
					className="h-6 w-6 flex-none text-kumo-subtle"
					onClick={() => setCollapsed((open) => !open)}
					aria-expanded={!collapsed}
					aria-controls={contentId}
					title={collapsed ? t`Expand container` : t`Collapse container`}
					aria-label={collapsed ? t`Expand container` : t`Collapse container`}
				>
					{collapsed ? (
						<CaretRight className="h-4 w-4" aria-hidden="true" />
					) : (
						<CaretDown className="h-4 w-4" aria-hidden="true" />
					)}
				</Button>

				<div
					className="flex cursor-grab items-center gap-1.5 text-kumo-subtle active:cursor-grabbing"
					data-drag-handle
					title={t`Drag to move this container`}
				>
					{layout === "grid" ? <SquaresFour className="h-4 w-4" /> : <Rows className="h-4 w-4" />}
					<span className="text-sm font-medium">{t`Nesting container`}</span>
					{/* Counts sit outside the translated words rather than inside a plural
					    message, so the summary reads correctly before catalogs are extracted.
					    A `<Plural>` here renders its own ICU source until then, which is worse
					    to look at than an unagreed plural. */}
					{collapsed && (
						<span className="text-kumo-subtle/70 text-sm">
							{columnCount} {t`columns`}
							{", "}
							{blockCount} {t`blocks`}
						</span>
					)}
				</div>

				{/* Layout controls describe content that is not on screen while collapsed, so
				    they fold away with it. Delete stays: an unwanted container should not have
				    to be opened first. */}
				<div className="ms-auto flex flex-wrap items-center gap-2">
					{!collapsed && (
						<>
							<Select
								label={t`Layout`}
								value={layout}
								onValueChange={(v) => updateAttributes({ layout: v === "flex" ? "flex" : "grid" })}
								items={{ grid: t`Grid`, flex: t`Flex` }}
							/>
							<Select
								label={t`Gap`}
								value={gap}
								onValueChange={(v) => updateAttributes({ gap: v ?? DEFAULTS.gap })}
								items={{ none: t`None`, sm: t`Small`, md: t`Medium`, lg: t`Large` }}
							/>
							<Select
								label={t`Align`}
								value={align}
								onValueChange={(v) => updateAttributes({ align: v ?? DEFAULTS.align })}
								items={{
									start: t`Top`,
									center: t`Center`,
									end: t`Bottom`,
									stretch: t`Stretch`,
								}}
							/>
							{/* Equal columns cannot express a content-plus-sidebar page, which is the
					    most common two-column layout, so the weighted presets exist for that.
					    Grid only: a flex container sizes its columns from their content, and
					    the site renderer ignores widths there too, so it is disabled rather
					    than left to look like it works. */}
							<Select
								label={t`Widths`}
								value={widths}
								disabled={layout !== "grid"}
								onValueChange={(v) => updateAttributes({ widths: v ?? DEFAULTS.widths })}
								items={{
									equal: t`Equal`,
									"wide-first": t`Wide first`,
									"wide-last": t`Wide last`,
									"narrow-first": t`Narrow first`,
									"narrow-last": t`Narrow last`,
								}}
							/>
							<Button
								type="button"
								variant="secondary"
								className="h-8 gap-1"
								onClick={addColumn}
								disabled={columnCount >= MAX_COLUMNS}
								title={t`Add column`}
								aria-label={t`Add column`}
							>
								<Plus className="h-4 w-4" />
								{t`Column`}
							</Button>
						</>
					)}
					<Button
						type="button"
						variant="ghost"
						shape="square"
						className="h-8 w-8 text-kumo-danger hover:bg-kumo-danger/10 hover:text-kumo-danger"
						onClick={() => deleteNode()}
						title={t`Delete`}
						aria-label={t`Delete nesting container`}
					>
						<Trash className="h-4 w-4" />
					</Button>
				</div>
			</div>
			{/* Hidden rather than unmounted: ProseMirror owns this element as the node's
			    contentDOM, and removing it detaches the container's content from the
			    document. */}
			<NodeViewContent
				id={contentId}
				className={cn("nesting-block-content p-3", collapsed && "hidden")}
				style={containerVars(layout, Math.max(MIN_COLUMNS, columnCount), gap, align, widths)}
			/>
		</NodeViewWrapper>
	);
}

export const NestingBlockExtension = Node.create({
	name: "nestingBlock",
	group: "block",
	content: "nestingColumn+",
	defining: true,
	isolating: true,
	draggable: true,
	selectable: true,

	addAttributes() {
		return {
			layout: {
				default: DEFAULTS.layout,
				parseHTML: (el: HTMLElement) =>
					el.getAttribute("data-layout") === "flex" ? "flex" : "grid",
				renderHTML: (attrs: Record<string, unknown>) => ({
					"data-layout": attrs.layout === "flex" ? "flex" : "grid",
				}),
			},
			gap: {
				default: DEFAULTS.gap,
				parseHTML: (el: HTMLElement) => el.getAttribute("data-gap") ?? DEFAULTS.gap,
				renderHTML: (attrs: Record<string, unknown>) => ({
					"data-gap": typeof attrs.gap === "string" ? attrs.gap : DEFAULTS.gap,
				}),
			},
			align: {
				default: DEFAULTS.align,
				parseHTML: (el: HTMLElement) => el.getAttribute("data-align") ?? DEFAULTS.align,
				renderHTML: (attrs: Record<string, unknown>) => ({
					"data-align": typeof attrs.align === "string" ? attrs.align : DEFAULTS.align,
				}),
			},
			widths: {
				default: DEFAULTS.widths,
				parseHTML: (el: HTMLElement) => el.getAttribute("data-widths") ?? DEFAULTS.widths,
				renderHTML: (attrs: Record<string, unknown>) => ({
					"data-widths": typeof attrs.widths === "string" ? attrs.widths : DEFAULTS.widths,
				}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "div[data-emdash-nesting-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-emdash-nesting-block": "" }), 0];
	},

	addNodeView() {
		return ReactNodeViewRenderer(NestingBlockNodeView);
	},
});
