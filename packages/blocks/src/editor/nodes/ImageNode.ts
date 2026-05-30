import { DecoratorNode } from "lexical";
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from "lexical";
import { $applyNodeReplacement } from "lexical";
import { createElement, type ReactNode } from "react";

export type ImageAlignment = "left" | "center" | "right";

export type SerializedImageNode = Spread<
	{
		type: "image";
		version: 1;
		src: string;
		alt: string;
		width: string;
		alignment: ImageAlignment;
	},
	SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<ReactNode> {
	__src: string;
	__alt: string;
	__width: string;
	__alignment: ImageAlignment;

	static override getType(): string {
		return "image";
	}

	static override clone(node: ImageNode, key?: NodeKey): ImageNode {
		return new ImageNode(node.__src, node.__alt, node.__width, node.__alignment, key);
	}

	static override importJSON(serialized: SerializedImageNode): ImageNode {
		return new ImageNode(serialized.src, serialized.alt, serialized.width, serialized.alignment);
	}

	constructor(
		src: string,
		alt?: string,
		width?: string,
		alignment?: ImageAlignment,
		key?: NodeKey,
	) {
		super(key);
		this.__src = src;
		this.__alt = alt ?? "";
		this.__width = width ?? "100%";
		this.__alignment = alignment ?? "center";
	}

	getSrc(): string {
		return this.__src;
	}

	getAlt(): string {
		return this.__alt;
	}

	getWidth(): string {
		return this.__width;
	}

	getAlignment(): ImageAlignment {
		return this.__alignment;
	}

	setSrc(src: string): void {
		const writable = this.getWritable();
		writable.__src = src;
	}

	setAlt(alt: string): void {
		const writable = this.getWritable();
		writable.__alt = alt;
	}

	setWidth(width: string): void {
		const writable = this.getWritable();
		writable.__width = width;
	}

	setAlignment(alignment: ImageAlignment): void {
		const writable = this.getWritable();
		writable.__alignment = alignment;
	}

	override createDOM(): HTMLDivElement {
		const container = document.createElement("div");
		container.setAttribute("data-lexical-node", "image");
		return container;
	}

	override updateDOM(): false {
		return false;
	}

	override decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
		return createElement(
			"div",
			{ style: { textAlign: this.__alignment } },
			createElement("img", {
				src: this.__src,
				alt: this.__alt,
				style: { width: this.__width },
				"data-drag-handle": "true",
			}),
		);
	}

	override exportJSON(): SerializedImageNode {
		return {
			...super.exportJSON(),
			type: "image",
			version: 1,
			src: this.__src,
			alt: this.__alt,
			width: this.__width,
			alignment: this.__alignment,
		};
	}
}

export function $createImageNode(
	src: string,
	alt?: string,
	width?: string,
	alignment?: ImageAlignment,
): ImageNode {
	return $applyNodeReplacement(new ImageNode(src, alt, width, alignment));
}
