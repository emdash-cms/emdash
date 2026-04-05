/**
 * Server-safe exports for @emdash-cms/blocks.
 *
 * Use this entry point in plugin route handlers and other server-side code
 * that doesn't have React available. Provides builders, validation, and types
 * without importing any React components.
 */

export { blocks, elements } from "./builders.js";
export { validateBlocks } from "./validation.js";

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
	CodeBlock,
	CodeLanguage,
	Block,
	// Interactions
	BlockAction,
	FormSubmit,
	PageLoad,
	BlockInteraction,
	// Response
	BlockResponse,
} from "./types.js";
