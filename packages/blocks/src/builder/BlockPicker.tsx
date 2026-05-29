import {
	ArrowsOutLineVertical,
	CursorClick,
	ImageSquare,
	Minus,
	Stack,
	TextT,
	type IconProps,
} from "@phosphor-icons/react";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$insertNodes,
	$getSelection,
} from "lexical";
import { useCallback, type ComponentType } from "react";

import { useLexicalEditorContext } from "../editor/context/LexicalEditorContext.js";
import {
	$createButtonNode,
	$createImageNode,
	$createContainerNode,
	$createDividerNode,
	$createSpacerNode,
} from "../editor/nodes/index.js";

export interface BlockDefinition {
	type: string;
	label: string;
	category: "layout" | "content" | "media";
	description?: string;
	icon: ComponentType<IconProps>;
}

const BLOCK_DEFINITIONS: BlockDefinition[] = [
	{
		type: "text",
		label: "Text",
		category: "content",
		description: "Paragraph copy for the page body",
		icon: TextT,
	},
	{
		type: "button",
		label: "Button",
		category: "content",
		description: "A clickable button element",
		icon: CursorClick,
	},
	{
		type: "image",
		label: "Image",
		category: "media",
		description: "An image block with alignment options",
		icon: ImageSquare,
	},
	{
		type: "container",
		label: "Section",
		category: "layout",
		description: "A framed page section",
		icon: Stack,
	},
	{
		type: "divider",
		label: "Divider",
		category: "layout",
		description: "A horizontal rule to separate content",
		icon: Minus,
	},
	{
		type: "spacer",
		label: "Spacer",
		category: "layout",
		description: "Empty vertical space",
		icon: ArrowsOutLineVertical,
	},
];

const CATEGORIES: Array<{ key: BlockDefinition["category"]; label: string }> = [
	{ key: "layout", label: "Layout" },
	{ key: "content", label: "Content" },
	{ key: "media", label: "Media" },
];

export function BlockPicker({ onInsert }: { onInsert?: (type: string) => void }) {
	const editor = useLexicalEditorContext();

	const handleInsert = useCallback(
		(block: BlockDefinition) => {
			editor.update(() => {
				const selection = $getSelection();

				let node;
				switch (block.type) {
					case "text": {
						const paragraph = $createParagraphNode();
						paragraph.append($createTextNode("Write something..."));
						node = paragraph;
						break;
					}
					case "button":
						node = $createButtonNode("Click me", "primary", "medium");
						break;
					case "image":
						node = $createImageNode("https://picsum.photos/600/300", "", "100%", "center");
						break;
					case "container":
						node = $createContainerNode();
						break;
					case "divider":
						node = $createDividerNode();
						break;
					case "spacer":
						node = $createSpacerNode("2rem");
						break;
					default:
						return;
				}

				if (selection) {
					$insertNodes([node]);
				} else {
					$getRoot().append(node);
				}
			});
			editor.focus();
			onInsert?.(block.type);
		},
		[editor, onInsert],
	);

	return (
		<div className="flex flex-col gap-4 p-4 min-w-[240px]">
			<div>
				<p className="text-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle">Blocks</p>
				<p className="mt-1 text-sm text-kumo-subtle">Add structure to the selected page field.</p>
			</div>

			{CATEGORIES.map((category) => {
				const blocks = BLOCK_DEFINITIONS.filter((block) => block.category === category.key);

				return (
					<section key={category.key} className="flex flex-col gap-2">
						<p className="text-xs font-medium text-kumo-subtle">{category.label}</p>
						<div className="grid gap-2">
							{blocks.map((block) => {
								const Icon = block.icon;
								return (
									<button
										key={block.type}
										type="button"
										onClick={() => handleInsert(block)}
										className="group flex min-h-[64px] items-start gap-3 rounded-md border border-kumo-line bg-kumo-bg p-3 text-start transition-colors hover:border-kumo-brand/50 hover:bg-kumo-hover focus:outline-none focus:ring-2 focus:ring-kumo-ring"
										title={block.description}
									>
										<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-kumo-muted text-kumo-text group-hover:bg-kumo-brand group-hover:text-white">
											<Icon size={18} weight="duotone" aria-hidden="true" />
										</span>
										<span className="min-w-0">
											<span className="block text-sm font-medium text-kumo-text">
												{block.label}
											</span>
											{block.description && (
												<span className="mt-0.5 block text-xs leading-4 text-kumo-subtle">
													{block.description}
												</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					</section>
				);
			})}
		</div>
	);
}
