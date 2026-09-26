/**
 * Server-safe exports for @emdash-cms/blocks.
 *
 * Use this entry point in plugin route handlers and other server-side code
 * that doesn't have React available. Provides builders, validation, and types
 * without importing any React components.
 */

export { blocks, elements } from "./builders.js";
export {
	BLOCK_RESPONSE_LIMITS,
	isEditorDraftPatchEffect,
	isSafePluginPagePath,
	normalizePluginPagePath,
	validateBlockResponse,
	validateBlocks,
	validateContentEditorActionResponse,
	validateContentEditorPanelInteraction,
	validateEditorDraftPatchEffect,
} from "./validation.js";
export type { BlockValidationPolicy, ValidationError } from "./validation.js";

export type {
	// Composition objects
	ConfirmDialog,
	// Elements
	ButtonElement,
	LinkElement,
	LinkTarget,
	NavigationElement,
	ActionElement,
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
	ContentEditorPanelInteraction,
	ContentEditorActionInvocation,
	PluginUiContext,
	ContentEditorActionResponse,
	EditorDraftFieldDefinition,
	EditorDraftInvocationReceipt,
	EditorDraftPatchEffect,
	EditorDraftPatchOperation,
	EditorDraftSnapshot,
	// Response
	BlockResponse,
} from "./types.js";
