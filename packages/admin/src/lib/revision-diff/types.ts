export type RevisionData = Readonly<Record<string, unknown>>;

export interface RevisionLike {
	id: string;
	data: RevisionData;
}

/** The parts of a collection field descriptor the diff reads. */
export interface DiffFieldDescriptor {
	kind: string;
	label?: string;
	options?: ReadonlyArray<{ value: string; label: string }> | Record<string, unknown>;
	validation?: Record<string, unknown>;
	widget?: string;
}

export interface DiffLimits {
	/** Token-pair cells one text may use before it falls back to whole-block mode. */
	maxTokenCellsPerText: number;
	/** Token-pair cells one revision diff may use in total. */
	maxTokenCellsTotal: number;
	/** Cells for the block-signature LCS inside one gap. */
	maxBlockLcsCells: number;
	/** Cells for similarity pairing inside one sub-gap. */
	maxSimilarityCells: number;
	/** Words similarity pairing may compare inside one sub-gap: each cell walks both blocks' words. */
	maxSimilarityWords: number;
}

export interface DiffOptions {
	/** Content locale, used for word segmentation. */
	locale?: string;
	/** The field the editor shows as the document title. */
	titleField?: string;
	/** How to describe a version with no previous revision to compare against. */
	noPrevious?: "created" | "earliest";
	/** Id of an older revision this version is an exact copy of. */
	restoredFrom?: string | null;
	limits?: Partial<DiffLimits>;
}

export type ChangeStatus = "unchanged" | "added" | "removed" | "changed";

/** A resolved Portable Text annotation (a markDef without its `_key`), such as a link. */
export type MarkAnnotation = Readonly<{ _type: string } & Record<string, unknown>>;

export interface SegmentMarks {
	/** Sorted decorator names, such as `strong` or `em`. */
	decorators: readonly string[];
	/** Annotations sorted by their canonical JSON. */
	annotations: readonly MarkAnnotation[];
}

export interface TextRun {
	text: string;
	marks: SegmentMarks;
}

export interface DiffSegment {
	/** May contain "\n" for a hard break. */
	text: string;
	change: "same" | "added" | "removed";
	/** New marks for same and added text, old marks for removed text. */
	marks: SegmentMarks;
	/** Shared by the removed and added segments of one replacement, so they render as a pair. */
	hunk: number | null;
	/** Same text as before with different marks. */
	formatChanged: boolean;
}

export interface TextDiff {
	/** `whole` is the large-text fallback: segments hold the new text as `same`. */
	mode: "inline" | "whole";
	textChanged: boolean;
	segments: readonly DiffSegment[];
}

interface BlockBase {
	/** The block's `_key`, or null when it has none. */
	key: string | null;
	/** The block's `_type`. */
	type: string;
	/** The block as stored, for rendering block types the diff treats as opaque. */
	raw: unknown;
}

export interface TextBlock extends BlockBase {
	kind: "text";
	style: string;
	listItem: string | null;
	level: number | null;
	listStart: number | null;
	textAlign: "center" | "right" | "justify" | null;
	runs: readonly TextRun[];
	text: string;
}

export interface ImageBlock extends BlockBase {
	kind: "image";
	/** Provider and asset identity, used to tell a replaced image from an edited one. */
	asset: string;
	alt: string;
	caption: string;
}

export interface CodeBlock extends BlockBase {
	kind: "code";
	language: string | null;
	code: string;
}

export interface OpaqueBlock extends BlockBase {
	kind: "opaque";
}

export type NormalizedBlock = TextBlock | ImageBlock | CodeBlock | OpaqueBlock;

export type BlockChange =
	| { kind: "text"; text: TextDiff; styleChanged: boolean }
	| {
			kind: "image";
			assetChanged: boolean;
			altChanged: boolean;
			captionChanged: boolean;
			otherChanged: boolean;
			caption: TextDiff;
	  }
	| { kind: "code"; code: TextDiff }
	| { kind: "opaque" };

/**
 * One rendered block of a Portable Text field, in document order. Removed blocks sit after the
 * block that preceded them.
 */
export type BlockRow =
	| { status: "unchanged"; targetId: string; block: NormalizedBlock; moved: boolean }
	| { status: "added"; targetId: string; block: NormalizedBlock }
	| { status: "removed"; targetId: string; block: NormalizedBlock }
	| {
			status: "changed";
			targetId: string;
			block: NormalizedBlock;
			previous: NormalizedBlock;
			change: BlockChange;
	  };

interface FieldDiffBase {
	slug: string;
	/** The field's label as the editor shows it, which is the capitalized slug when it has none. */
	label: string;
	kind: string;
	status: ChangeStatus;
	targetId: string;
}

export type FieldDiff =
	| (FieldDiffBase & { type: "text"; text: TextDiff })
	| (FieldDiffBase & { type: "portableText"; rows: readonly BlockRow[] })
	| (FieldDiffBase & { type: "boolean"; before: boolean; after: boolean })
	| (FieldDiffBase & { type: "value"; before: unknown; after: unknown });

export interface FieldRef {
	slug: string;
	label: string;
}

export interface Snippet {
	text: string;
	truncated: boolean;
}

export type BlockNoun =
	| "paragraph"
	| "heading"
	| "quote"
	| "listItem"
	| "image"
	| "code"
	| "table"
	| "gallery"
	| "video"
	| "embed"
	| "html"
	| "divider"
	| "custom";

/** What changed, in a form the UI turns into a localized sentence. */
export type ChangeItem =
	| { kind: "created" }
	| { kind: "earliest" }
	| { kind: "restored"; revisionId: string }
	| { kind: "noChanges" }
	| { kind: "title"; field: FieldRef; target: string }
	| { kind: "text"; field: FieldRef; change: "added" | "removed" | "edited"; target: string }
	| { kind: "toggle"; field: FieldRef; on: boolean; target: string }
	| { kind: "field"; field: FieldRef; target: string }
	| { kind: "slug"; after: string | null }
	| {
			kind: "block";
			field: FieldRef;
			action: "added" | "removed" | "edited" | "restyled" | "moved";
			noun: BlockNoun;
			snippet: Snippet | null;
			target: string;
	  }
	| {
			kind: "image";
			field: FieldRef;
			action: "added" | "removed" | "replaced" | "captionEdited" | "altEdited" | "changed";
			target: string;
	  };

export interface RevisionDiff {
	hasPrevious: boolean;
	/** Every field in field order, changed or not, so the view can draw the whole document. */
	fields: readonly FieldDiff[];
	/** Null when either revision has no `_slug`. */
	slug: { status: ChangeStatus; before: string | null; after: string | null } | null;
	changes: readonly ChangeItem[];
}

export interface VersionDiffInput {
	/** Loaded revisions, newest first, including the extra one loaded for comparison. */
	revisions: readonly RevisionLike[];
	/** Index into `revisions` of the version to describe. */
	index: number;
	/** How many revisions the server holds for the entry. */
	total: number;
	fields: Readonly<Record<string, DiffFieldDescriptor>>;
	locale?: string;
	titleField?: string;
}
