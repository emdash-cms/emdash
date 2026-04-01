/**
 * Gutenberg Block Editor Integration
 *
 * Wraps the WordPress Gutenberg block editor (@wordpress/block-editor) to work
 * within EmDash's admin UI. Content is stored as Portable Text internally, and
 * this component handles the conversion to/from Gutenberg's block format.
 *
 * This provides a much richer editing experience compared to a basic WYSIWYG
 * editor, with support for blocks, drag-and-drop, and the full WordPress
 * block editing paradigm.
 */

import {
	BlockEditorProvider,
	BlockList,
	BlockInspector,
	WritingFlow,
	ObserveTyping,
} from "@wordpress/block-editor";
import {
	unregisterBlockType,
	getBlockTypes,
	type BlockInstance,
} from "@wordpress/blocks";
// @ts-ignore - @wordpress/block-library does not ship types
import { registerCoreBlocks } from "@wordpress/block-library";
import { SlotFillProvider, Popover } from "@wordpress/components";
import * as React from "react";

import { cn } from "../lib/utils";
import {
	portableTextToGutenberg,
	gutenbergToPortableText,
	type PortableTextBlock,
} from "./editor/gutenberg-portable-text";

// Track initialization state
let coreBlocksRegistered = false;

// Allowed core block types for content editing
const ALLOWED_BLOCKS = [
	"core/paragraph",
	"core/heading",
	"core/list",
	"core/list-item",
	"core/quote",
	"core/image",
	"core/code",
	"core/separator",
	"core/spacer",
	"core/columns",
	"core/column",
	"core/group",
	"core/preformatted",
	"core/pullquote",
	"core/table",
	"core/html",
	"core/freeform",
];

function initializeGutenberg() {
	if (coreBlocksRegistered) return;

	try {
		registerCoreBlocks();
	} catch {
		// Core blocks may already be registered
	}

	// Unregister blocks that don't make sense outside WordPress
	try {
		const allBlocks = getBlockTypes();
		for (const block of allBlocks) {
			if (!ALLOWED_BLOCKS.includes(block.name)) {
				try {
					unregisterBlockType(block.name);
				} catch {
					// Block may not be registered
				}
			}
		}
	} catch {
		// Block types may not be available yet
	}

	coreBlocksRegistered = true;
}

export interface GutenbergEditorProps {
	value?: PortableTextBlock[];
	onChange?: (value: PortableTextBlock[]) => void;
	placeholder?: string;
	className?: string;
	editable?: boolean;
	"aria-labelledby"?: string;
	minimal?: boolean;
}

export function GutenbergEditor({
	value,
	onChange,
	placeholder: _placeholder = "Start writing...",
	className,
	editable = true,
	"aria-labelledby": ariaLabelledby,
	minimal = false,
}: GutenbergEditorProps) {
	const onChangeRef = React.useRef(onChange);
	React.useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	// Initialize Gutenberg core blocks once
	React.useEffect(() => {
		initializeGutenberg();
	}, []);

	// Convert Portable Text to Gutenberg blocks on mount
	const [blocks, setBlocks] = React.useState<BlockInstance[]>(() => {
		if (!value || value.length === 0) return [];
		try {
			return portableTextToGutenberg(value);
		} catch {
			return [];
		}
	});

	const handleInput = React.useCallback((newBlocks: BlockInstance[]) => {
		setBlocks(newBlocks);
	}, []);

	const handleChange = React.useCallback((newBlocks: BlockInstance[]) => {
		setBlocks(newBlocks);
		const cb = onChangeRef.current;
		if (cb) {
			try {
				const portableText = gutenbergToPortableText(newBlocks);
				cb(portableText);
			} catch (err) {
				console.error("[GutenbergEditor] Failed to convert blocks to Portable Text:", err);
			}
		}
	}, []);

	return (
		<div
			className={cn(
				"gutenberg-editor-wrapper border rounded-lg overflow-hidden",
				minimal && "border-0 rounded-none -mx-4",
				className,
			)}
			aria-labelledby={ariaLabelledby}
		>
			<SlotFillProvider>
				<BlockEditorProvider
					value={blocks}
					onInput={handleInput}
					onChange={handleChange}
					settings={{
						hasFixedToolbar: true,
						bodyPlaceholder: _placeholder,
					} as Record<string, unknown>}
				>
					<div className="gutenberg-editor-layout flex">
						<div className="gutenberg-editor-content flex-1 min-h-[300px]">
							<WritingFlow>
								<ObserveTyping>
									<BlockList />
								</ObserveTyping>
							</WritingFlow>
						</div>
						{!minimal && editable && (
							<div className="gutenberg-editor-sidebar w-[280px] border-l bg-kumo-tint/30 p-4 overflow-y-auto max-h-[600px]">
								<BlockInspector />
							</div>
						)}
					</div>
					<Popover.Slot />
				</BlockEditorProvider>
			</SlotFillProvider>
		</div>
	);
}

export default GutenbergEditor;
