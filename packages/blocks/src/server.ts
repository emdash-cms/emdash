/**
 * Server-safe exports for @emdash-cms/blocks.
 *
 * Use this entry point in plugin route handlers and other server-side code
 * that doesn't have React available. Provides builders, validation, and types
 * without importing any React components.
 */

export { blocks, elements } from "./builders.js";
export { validateBlocks } from "./validation.js";
export { renderBlockDocument } from "./builder/renderer.js";
export { exportToBuilderSchema } from "./builder/lexical-to-builder.js";
export { validateBuilderDocument, newBuilderDocument, newBlockId } from "./builder/schema.js";

export type {
	BuilderBlock,
	BuilderDocument,
	BuilderColumnsBlock,
	BuilderRichTextBlock,
	BuilderSectionBlock,
	PortableTextNode,
	ValidationError,
} from "./builder/schema.js";

export type {
	// Composition objects
	ConfirmDialog,
	// Elements
	ButtonElement,
	TextInputElement,
	NumberInputElement,
	SelectElement,
	ToggleElement,
	SecretInputElement,
	Element,
	// Form
	FieldCondition,
	FormField,
	// Block sub-types
	TableColumn,
	StatItem,
	// Blocks
	HeaderBlock,
	SectionBlock,
	DividerBlock,
	FieldsBlock,
	TableBlock,
	ActionsBlock,
	StatsBlock,
	FormBlock,
	ImageBlock,
	ContextBlock,
	ColumnsBlock,
	Block,
	// Interactions
	BlockAction,
	FormSubmit,
	PageLoad,
	BlockInteraction,
	// Response
	BlockResponse,
} from "./types.js";
