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
import { DotsSixVertical, Plus, Rows, SquaresFour, Trash, X } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

type NestingLayout = "grid" | "flex";
type NestingGap = "none" | "sm" | "md" | "lg";
type NestingAlign = "start" | "center" | "end" | "stretch";

const DEFAULTS = {
	layout: "grid" as NestingLayout,
	gap: "md" as NestingGap,
	align: "start" as NestingAlign,
};

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;

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

function containerVars(
	layout: NestingLayout,
	columnCount: number,
	gap: NestingGap,
	align: NestingAlign,
): React.CSSProperties {
	return {
		"--nesting-display": layout === "grid" ? "grid" : "flex",
		"--nesting-cols": `repeat(${columnCount}, minmax(0, 1fr))`,
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
	const gap: NestingGap = (["none", "sm", "md", "lg"] as const).includes(node.attrs.gap)
		? node.attrs.gap
		: DEFAULTS.gap;
	const align: NestingAlign = (["start", "center", "end", "stretch"] as const).includes(
		node.attrs.align,
	)
		? node.attrs.align
		: DEFAULTS.align;

	const columnCount = node.childCount;

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
				<div
					className="cursor-grab text-kumo-subtle/60 active:cursor-grabbing"
					data-drag-handle
					aria-hidden="true"
				>
					<DotsSixVertical className="h-5 w-5" />
				</div>

				<div className="flex items-center gap-1.5 text-kumo-subtle">
					{layout === "grid" ? <SquaresFour className="h-4 w-4" /> : <Rows className="h-4 w-4" />}
					<span className="text-sm font-medium">{t`Nesting container`}</span>
				</div>

				<div className="ms-auto flex flex-wrap items-center gap-2">
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
			<NodeViewContent
				className="nesting-block-content p-3"
				style={containerVars(layout, Math.max(MIN_COLUMNS, columnCount), gap, align)}
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
