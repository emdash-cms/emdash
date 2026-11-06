import { useLingui } from "@lingui/react/macro";
import {
	Browser,
	FileHtml,
	type Icon,
	ImageBroken,
	Images,
	PuzzlePiece,
	Table,
	VideoCamera,
} from "@phosphor-icons/react";
import * as React from "react";

import { getMediaObjectPosition } from "../../lib/media-utils.js";
import { isRecord } from "../../lib/revision-diff/normalize.js";
import type {
	BlockRow,
	CodeBlock,
	ImageBlock,
	OpaqueBlock,
	TextBlock,
} from "../../lib/revision-diff/types.js";
import { cn } from "../../lib/utils.js";
import {
	type DocumentItem,
	documentItems,
	galleryView,
	imageLayout,
	type ListItemNode,
	type ListNode,
	markAttributes,
	storedImageUrl,
	type TableRowView,
	tableRows,
} from "./revision-blocks.js";
import { revisionTargetElementId } from "./revision-format.js";
import { ChangePrefix, DiffText, EmptyValue, RunsText, visibleText } from "./RevisionSegments.js";

const DOCUMENT_ROOT_CLASSES = "emdash-document flow-root min-h-32 pb-2";
const BOXED_ROOT_CLASSES =
	"prose prose-sm sm:prose-base flow-root w-full max-w-[calc(75ch+8rem)] mx-auto min-h-[200px] p-4 ps-14 pe-14 sm:ps-16 sm:pe-16";

interface RowProps {
	row: BlockRow;
	marked: boolean;
}

/** Rows a change can point at: anything that changed, and blocks that only moved. */
function targetProps(row: BlockRow) {
	return row.status === "unchanged" && !row.moved
		? {}
		: { id: revisionTargetElementId(row.targetId), tabIndex: -1 };
}

/** Unchanged rows draw the same either way, so they skip re-rendering when the marks toggle. */
function rowMarked(row: BlockRow, marked: boolean): boolean {
	return row.status === "unchanged" ? false : marked;
}

type TextTreatment = "plain" | "added" | "removed" | "rewritten" | "restyled" | "inline";

function textTreatment(row: BlockRow, marked: boolean): TextTreatment {
	if (!marked) return "plain";
	switch (row.status) {
		case "unchanged":
			return "plain";
		case "added":
			return "added";
		case "removed":
			return "removed";
		case "changed": {
			if (row.change.kind !== "text") return "inline";
			const { text, styleChanged } = row.change;
			if (text.textChanged && text.mode === "whole") return "rewritten";
			if (!text.textChanged && styleChanged) return "restyled";
			return "inline";
		}
	}
}

/** Keeps an empty block, or a hard break at the end of one, a line tall, as the editor does. */
function trailingBreak(text: string): React.ReactNode {
	return text === "" || text.endsWith("\n") ? <br /> : null;
}

const TextContent = React.memo(function TextContent({
	row,
	block,
	marked,
}: RowProps & { block: TextBlock }) {
	const { t } = useLingui();
	const treatment = textTreatment(row, marked);
	if (treatment === "inline" && row.status === "changed" && row.change.kind === "text") {
		const { segments } = row.change.text;
		return (
			<>
				<DiffText segments={segments} marked />
				{trailingBreak(visibleText(segments, true))}
			</>
		);
	}
	const text = <RunsText runs={block.runs} />;
	const end = trailingBreak(block.text);
	switch (treatment) {
		case "added":
			return (
				<>
					<ChangePrefix>{t`Added:`}</ChangePrefix>
					{text}
					{end}
				</>
			);
		case "removed":
			return (
				<>
					<del>
						<ChangePrefix>{t`Removed:`}</ChangePrefix>
						{text}
					</del>
					{end}
				</>
			);
		case "rewritten":
			return (
				<>
					<ChangePrefix>{t`Changed:`}</ChangePrefix>
					{text}
					{end}
				</>
			);
		case "restyled":
			return (
				<>
					<span data-revision-restyled="">
						<ChangePrefix>{t`Style changed:`}</ChangePrefix>
						{text}
					</span>
					{end}
				</>
			);
		default:
			return (
				<>
					{text}
					{end}
				</>
			);
	}
});

function tintProps(row: BlockRow, marked: boolean) {
	const treatment = textTreatment(row, marked);
	return treatment === "added" || treatment === "rewritten" ? { "data-revision-tint": "" } : {};
}

function alignStyle(block: TextBlock): React.CSSProperties | undefined {
	return block.textAlign ? { textAlign: block.textAlign } : undefined;
}

const HEADING_TAGS = {
	h1: "h1",
	h2: "h2",
	h3: "h3",
	h4: "h4",
	h5: "h5",
	h6: "h6",
} as const;

function headingTag(style: string) {
	return Object.hasOwn(HEADING_TAGS, style)
		? HEADING_TAGS[style as keyof typeof HEADING_TAGS]
		: null;
}

function TextBlockView({ row, block, marked }: RowProps & { block: TextBlock }) {
	const content = <TextContent row={row} block={block} marked={rowMarked(row, marked)} />;
	if (block.style === "blockquote") {
		return (
			<blockquote {...targetProps(row)} {...tintProps(row, marked)}>
				<p>{content}</p>
			</blockquote>
		);
	}
	const Tag = headingTag(block.style) ?? "p";
	return (
		<Tag {...targetProps(row)} {...tintProps(row, marked)} style={alignStyle(block)}>
			{content}
		</Tag>
	);
}

function ListView({ list, marked }: { list: ListNode; marked: boolean }) {
	const items = list.items.map((item) => (
		<ListItemView key={item.row.targetId} item={item} marked={marked} />
	));
	if (!list.ordered) return <ul>{items}</ul>;
	return <ol start={list.start === 1 ? undefined : list.start}>{items}</ol>;
}

function ListItemView({ item, marked }: { item: ListItemNode; marked: boolean }) {
	const { row } = item;
	const block = row.block;
	if (block.kind !== "text") return null;
	return (
		<li {...targetProps(row)}>
			<p {...tintProps(row, marked)} style={alignStyle(block)}>
				<TextContent row={row} block={block} marked={rowMarked(row, marked)} />
			</p>
			{item.children.map((child) => (
				<ListView key={child.items[0]?.row.targetId} list={child} marked={marked} />
			))}
		</li>
	);
}

/** Marks shared by framed blocks: a ring when added or changed, dimmed when removed. */
function frameState(row: BlockRow, marked: boolean, changed: boolean) {
	if (!marked) return { ring: false, dim: false };
	return {
		ring: row.status === "added" || (row.status === "changed" && changed),
		dim: row.status === "removed",
	};
}

function useStatusPrefix(row: BlockRow, marked: boolean, changedLabel: string | null) {
	const { t } = useLingui();
	if (!marked) return null;
	switch (row.status) {
		case "added":
			return t`Added:`;
		case "removed":
			return t`Removed:`;
		case "changed":
			return changedLabel;
		default:
			return null;
	}
}

const ImageRow = React.memo(function ImageRow({
	row,
	block,
	marked,
}: RowProps & { block: ImageBlock }) {
	const { t } = useLingui();
	const change = row.status === "changed" && row.change.kind === "image" ? row.change : null;
	const replaced = Boolean(change?.assetChanged);
	const reframed = Boolean(
		change && (change.assetChanged || change.altChanged || change.otherChanged),
	);
	const prefix = useStatusPrefix(
		row,
		marked,
		replaced ? t`Image replaced:` : reframed ? t`Changed:` : null,
	);
	const { ring, dim } = frameState(row, marked, reframed);
	const layout = imageLayout(block.raw);
	const url = storedImageUrl(block.raw);
	const { alignment, width, height } = layout;

	let caption: React.ReactNode = null;
	if (change && marked) {
		if (visibleText(change.caption.segments, true)) {
			caption = <DiffText segments={change.caption.segments} marked />;
		}
	} else if (block.caption) {
		caption = dim ? <del>{block.caption}</del> : block.caption;
	}

	return (
		<div {...targetProps(row)}>
			<div
				data-node-view-wrapper=""
				className={cn(
					"relative my-4 max-w-full whitespace-normal",
					(alignment === "left" || alignment === "right") &&
						"w-full min-[641px]:w-fit min-[641px]:max-w-1/2",
					// The editor's image node floats by the stored side; a version lays out the same way.
					alignment === "left" && "min-[641px]:[float:left] min-[641px]:me-6",
					alignment === "right" && "min-[641px]:[float:right] min-[641px]:ms-6",
				)}
				style={alignment === "center" ? { width: "fit-content", marginInline: "auto" } : undefined}
			>
				<figure className="relative my-0!">
					<ChangePrefix>{prefix}</ChangePrefix>
					{url ? (
						<img
							src={url}
							alt={block.alt}
							title={layout.title}
							className="rounded-lg max-w-full h-auto object-cover"
							width={width}
							height={height}
							style={{ aspectRatio: width && height ? `${width} / ${height}` : undefined }}
							loading="lazy"
							draggable={false}
							{...markAttributes({ ring, dim })}
						/>
					) : (
						<div
							role="img"
							aria-label={block.alt || t`Image`}
							className="flex min-h-20 items-center justify-center rounded-lg border bg-kumo-tint text-kumo-subtle"
							{...markAttributes({ ring, dim })}
						>
							<ImageBroken className="size-5" aria-hidden="true" />
						</div>
					)}
					{caption && (
						<figcaption className="text-center text-sm text-kumo-subtle mt-2" dir="auto">
							{caption}
						</figcaption>
					)}
				</figure>
			</div>
		</div>
	);
});

const CodeRow = React.memo(function CodeRow({
	row,
	block,
	marked,
}: RowProps & { block: CodeBlock }) {
	const { t } = useLingui();
	const change = row.status === "changed" && row.change.kind === "code" ? row.change : null;
	const inline = Boolean(change && change.code.textChanged && change.code.mode === "inline");
	const prefix = useStatusPrefix(row, marked, inline ? null : t`Changed:`);
	const { ring } = frameState(row, marked, !inline);

	let content: React.ReactNode = block.code;
	if (marked && change && inline) content = <DiffText segments={change.code.segments} marked />;
	else if (marked && row.status === "removed") content = <del>{block.code}</del>;

	return (
		<div {...targetProps(row)}>
			<div
				data-node-view-wrapper=""
				className="emdash-code-block-node relative my-4 whitespace-normal"
				data-language={block.language ?? undefined}
				{...markAttributes({ ring, dim: false })}
			>
				<pre className="emdash-code-block">
					<code>
						<ChangePrefix>{prefix}</ChangePrefix>
						{content}
					</code>
				</pre>
			</div>
		</div>
	);
});

function BlockCard({
	icon: BlockIcon,
	label,
	detail,
}: {
	icon: Icon;
	label: string;
	detail?: string;
}) {
	return (
		<div className="rounded-lg border bg-kumo-base">
			<div className="flex items-center gap-3 px-4 py-3">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-subtle">
					<BlockIcon className="size-5" aria-hidden="true" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium" dir="auto">
						{label}
					</div>
					{detail && (
						<div className="truncate font-mono text-xs text-kumo-subtle" dir="auto">
							{detail}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function stringField(raw: unknown, ...keys: string[]): string | undefined {
	if (!isRecord(raw)) return undefined;
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function urlHost(value: string | undefined): string | undefined {
	if (!value || !URL.canParse(value)) return value;
	return new URL(value).host || value;
}

function firstLine(value: string | undefined): string | undefined {
	return value
		?.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
}

function TableView({ rows }: { rows: readonly TableRowView[] }) {
	return (
		<table>
			<tbody>
				{rows.map((row) => (
					<tr key={row.key}>
						{row.cells.map((cell) => {
							const Cell = cell.header ? "th" : "td";
							return (
								<Cell
									key={cell.key}
									colSpan={cell.colSpan}
									rowSpan={cell.rowSpan}
									style={cell.textAlign ? { textAlign: cell.textAlign } : undefined}
								>
									<p>
										<RunsText runs={cell.runs} />
									</p>
								</Cell>
							);
						})}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function GalleryView({ raw }: { raw: unknown }) {
	const { t } = useLingui();
	const gallery = galleryView(raw);
	if (!gallery || gallery.images.length === 0) {
		return <BlockCard icon={Images} label={t`Gallery`} detail={t`Empty`} />;
	}
	return (
		<div
			className="grid gap-2 rounded-lg"
			style={{ gridTemplateColumns: `repeat(${gallery.columns}, 1fr)` }}
		>
			{gallery.images.map((image) => (
				<figure key={image.key} className="m-0">
					{image.url ? (
						<img
							src={image.url}
							alt={image.alt}
							className="w-full aspect-square object-cover rounded-md border"
							style={{ objectPosition: getMediaObjectPosition(image) }}
							loading="lazy"
							draggable={false}
						/>
					) : (
						<div
							role="img"
							aria-label={image.alt || t`Image`}
							className="flex aspect-square w-full items-center justify-center rounded-md border bg-kumo-tint text-kumo-subtle"
						>
							<ImageBroken className="size-5" aria-hidden="true" />
						</div>
					)}
					{image.caption && (
						<figcaption className="text-xs text-kumo-subtle mt-1 text-center truncate" dir="auto">
							{image.caption}
						</figcaption>
					)}
				</figure>
			))}
		</div>
	);
}

function OpaqueBody({ block }: { block: OpaqueBlock }) {
	const { t } = useLingui();
	const { raw } = block;
	switch (block.type) {
		case "gallery":
			return <GalleryView raw={raw} />;
		case "video":
			return (
				<BlockCard
					icon={VideoCamera}
					label={t`Video`}
					detail={
						stringField(raw, "caption") ??
						(isRecord(raw) ? stringField(raw.asset, "filename", "url") : undefined)
					}
				/>
			);
		case "iframe":
			return (
				<BlockCard
					icon={Browser}
					label={t`Embed`}
					detail={stringField(raw, "title") ?? urlHost(stringField(raw, "src"))}
				/>
			);
		case "htmlBlock":
			return (
				<BlockCard icon={FileHtml} label={t`HTML`} detail={firstLine(stringField(raw, "html"))} />
			);
		case "table":
			return <BlockCard icon={Table} label={t`Table`} />;
		default:
			return (
				<BlockCard icon={PuzzlePiece} label={block.type} detail={stringField(raw, "id", "url")} />
			);
	}
}

const OpaqueRow = React.memo(function OpaqueRow({
	row,
	block,
	marked,
}: RowProps & { block: OpaqueBlock }) {
	const { t } = useLingui();
	const prefix = useStatusPrefix(row, marked, t`Changed:`);
	const frame = markAttributes(frameState(row, marked, true));

	if (block.type === "break") return <hr {...targetProps(row)} {...frame} />;

	const table = block.type === "table" ? tableRows(block.raw) : null;
	if (table) {
		return (
			<div {...targetProps(row)} className="tableWrapper" {...frame}>
				<ChangePrefix>{prefix}</ChangePrefix>
				<TableView rows={table} />
			</div>
		);
	}

	return (
		<div {...targetProps(row)}>
			<ChangePrefix>{prefix}</ChangePrefix>
			<div data-node-view-wrapper="" className="relative my-4 whitespace-normal" {...frame}>
				<OpaqueBody block={block} />
			</div>
		</div>
	);
});

function BlockRowView({ row, marked }: RowProps) {
	const block = row.block;
	const rowIsMarked = rowMarked(row, marked);
	switch (block.kind) {
		case "text":
			return <TextBlockView row={row} block={block} marked={marked} />;
		case "image":
			return <ImageRow row={row} block={block} marked={rowIsMarked} />;
		case "code":
			return <CodeRow row={row} block={block} marked={rowIsMarked} />;
		default:
			return <OpaqueRow row={row} block={block} marked={rowIsMarked} />;
	}
}

function DocumentItemView({ item, marked }: { item: DocumentItem; marked: boolean }) {
	return item.kind === "list" ? (
		<ListView list={item.list} marked={marked} />
	) : (
		<BlockRowView row={item.row} marked={marked} />
	);
}

/**
 * A Portable Text field drawn with the editor's markup and classes, so the version reads like
 * the document it was. `document` is the entry's body; other rich text fields are `boxed`.
 */
export function RevisionDocument({
	rows,
	variant,
	marked,
}: {
	rows: readonly BlockRow[];
	variant: "document" | "boxed";
	marked: boolean;
}) {
	const items = React.useMemo(() => documentItems(rows, marked), [rows, marked]);
	return (
		<div
			data-emdash-editor-surface=""
			data-emdash-editor-variant={variant}
			className={
				variant === "document"
					? "relative"
					: "overflow-clip rounded-lg border bg-kumo-control [--emdash-editor-surface:var(--color-kumo-control)]"
			}
		>
			<div
				data-emdash-static-document=""
				dir="auto"
				className={variant === "document" ? DOCUMENT_ROOT_CLASSES : BOXED_ROOT_CLASSES}
			>
				{items.length === 0 ? (
					<p>
						<EmptyValue />
					</p>
				) : (
					items.map((item) => (
						<DocumentItemView
							key={item.kind === "list" ? item.key : item.row.targetId}
							item={item}
							marked={marked}
						/>
					))
				)}
			</div>
		</div>
	);
}
