/**
 * Builder Document Schema — portable, independent of Lexical.
 *
 * This schema is the source of truth for page content.
 * Lexical is the editing surface only.
 *
 * Lexical JSON → exportToBuilderSchema() → BuilderDocument
 * BuilderDocument → renderBlockDocument() → HTML
 *
 * Validation: manual (no external dependency — consistent with validation.ts)
 */

// ── Portable Text (Lexical I/O format) ────────────────────────────────────────

export interface PortableTextNode {
	_type: string;
	_key?: string;
	text?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	children?: PortableTextNode[];
}

// ── Builder Block Types ────────────────────────────────────────────────────────

export interface BuilderSectionBlock {
	id: string;
	type: "section";
	props?: {
		background?: string;
		padding?: string;
		maxWidth?: string;
	};
	children?: BuilderBlock[];
}

export interface BuilderColumn {
	id: string;
	width?: number; // grid units (e.g. 6 of 12)
	blocks: BuilderBlock[];
}

export interface BuilderColumnsBlock {
	id: string;
	type: "columns";
	props?: { gap?: string };
	columns: BuilderColumn[];
}

export interface BuilderRichTextBlock {
	id: string;
	type: "richText";
	props?: Record<string, unknown>;
	content?: PortableTextNode[];
}

export interface BuilderImageBlock {
	id: string;
	type: "image";
	props?: {
		assetId?: string;
		src?: string;
		alt?: string;
		width?: string;
		alignment?: "left" | "center" | "right";
	};
}

export interface BuilderButtonBlock {
	id: string;
	type: "button";
	props?: {
		text?: string;
		href?: string;
		variant?: "primary" | "secondary" | "outline";
		size?: "small" | "medium" | "large";
	};
}

export interface BuilderDividerBlock {
	id: string;
	type: "divider";
	props?: Record<string, unknown>;
}

export interface BuilderSpacerBlock {
	id: string;
	type: "spacer";
	props?: { height?: string };
}

export interface BuilderContainerBlock {
	id: string;
	type: "container";
	props?: {
		background?: string;
		padding?: string;
		maxWidth?: string;
	};
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type BuilderBlock =
	| BuilderSectionBlock
	| BuilderColumnsBlock
	| BuilderRichTextBlock
	| BuilderImageBlock
	| BuilderButtonBlock
	| BuilderDividerBlock
	| BuilderSpacerBlock
	| BuilderContainerBlock;

// ── Document ────────────────────────────────────────────────────────────────

export interface BuilderDocument {
	version: 1;
	blocks: BuilderBlock[];
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationError {
	path: string;
	message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validatePortableTextNode(node: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(node)) {
		errors.push({ path, message: "Portable text node must be an object" });
		return;
	}
	if (typeof node._type !== "string") {
		errors.push({ path: `${path}._type`, message: "Field _type must be a string" });
	}
	if (node.children !== undefined && !Array.isArray(node.children)) {
		errors.push({ path: `${path}.children`, message: "Field children must be an array" });
	}
}

function validateBuilderBlock(block: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(block)) {
		errors.push({ path, message: "Block must be an object" });
		return;
	}

	const type = block.type;
	if (typeof type !== "string") {
		errors.push({ path: `${path}.type`, message: "Field type must be a string" });
		return;
	}

	switch (type) {
		case "section": {
			if (block.children !== undefined && !Array.isArray(block.children)) {
				errors.push({ path: `${path}.children`, message: "Field children must be an array" });
			} else if (Array.isArray(block.children)) {
				block.children.forEach((child, i) =>
					validateBuilderBlock(child, `${path}.children[${i}]`, errors),
				);
			}
			break;
		}

		case "columns": {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cols = (block as any).columns;
			if (!Array.isArray(cols)) {
				errors.push({ path: `${path}.columns`, message: "Field columns must be an array" });
			} else {
				cols.forEach((col: unknown, i: number) => {
					if (!isRecord(col)) {
						errors.push({ path: `${path}.columns[${i}]`, message: "Column must be an object" });
						return;
					}
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const colBlocks = (col as any).blocks;
					if (!Array.isArray(colBlocks)) {
						errors.push({
							path: `${path}.columns[${i}].blocks`,
							message: "Field blocks must be an array",
						});
					} else {
						colBlocks.forEach((b: unknown, j: number) =>
							validateBuilderBlock(b, `${path}.columns[${i}].blocks[${j}]`, errors),
						);
					}
				});
			}
			break;
		}

		case "richText": {
			if (block.content !== undefined && !Array.isArray(block.content)) {
				errors.push({ path: `${path}.content`, message: "Field content must be an array" });
			} else if (Array.isArray(block.content)) {
				block.content.forEach((node, i) =>
					validatePortableTextNode(node, `${path}.content[${i}]`, errors),
				);
			}
			break;
		}

		case "image": {
			// props validated by shape
			break;
		}

		case "button": {
			// props validated by shape
			break;
		}

		case "spacer": {
			// props validated by shape
			break;
		}

		case "divider": {
			// no required fields
			break;
		}

		case "container": {
			// props validated by shape
			break;
		}

		default:
			errors.push({ path: `${path}.type`, message: `Unknown block type '${type}'` });
	}
}

export function validateBuilderDocument(doc: unknown): {
	valid: boolean;
	errors: ValidationError[];
} {
	const errors: ValidationError[] = [];

	if (!isRecord(doc)) {
		return { valid: false, errors: [{ path: "root", message: "Document must be an object" }] };
	}

	if (doc.version !== 1) {
		// Legacy format (e.g., raw Lexical JSON) — treat as valid but mark error.
		// The conversion layer (exportToBuilderSchema) handles legacy formats.
		if ("root" in doc || !("blocks" in doc)) {
			// Looks like Lexical JSON, not BuilderDocument — still valid from
			// the perspective of "we can work with this"
			return { valid: true, errors: [] };
		}
		errors.push({ path: "version", message: `Expected version 1, got '${doc.version}'` });
	}

	if (!Array.isArray(doc.blocks)) {
		return {
			valid: false,
			errors: [...errors, { path: "blocks", message: "Field blocks must be an array" }],
		};
	}

	doc.blocks.forEach((block, i) => {
		validateBuilderBlock(block, `blocks[${i}]`, errors);
	});

	return { valid: errors.length === 0, errors };
}

export function newBuilderDocument(): BuilderDocument {
	return { version: 1, blocks: [] };
}

export function newBlockId(): string {
	return `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
