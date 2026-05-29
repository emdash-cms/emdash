import { DecoratorNode } from "lexical";
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from "lexical";
import { $applyNodeReplacement } from "lexical";
import { createElement, type CSSProperties, type ReactNode } from "react";

export type SerializedContainerNode = Spread<
	{
		type: "container";
		version: 1;
		background: string;
		padding: string;
		maxWidth: string;
	},
	SerializedLexicalNode
>;

export class ContainerNode extends DecoratorNode<ReactNode> {
	__background: string;
	__padding: string;
	__maxWidth: string;

	static override getType(): string {
		return "container";
	}

	static override clone(node: ContainerNode, key?: NodeKey): ContainerNode {
		return new ContainerNode(node.__background, node.__padding, node.__maxWidth, key);
	}

	static override importJSON(serialized: SerializedContainerNode): ContainerNode {
		return new ContainerNode(serialized.background, serialized.padding, serialized.maxWidth);
	}

	constructor(background?: string, padding?: string, maxWidth?: string, key?: NodeKey) {
		super(key);
		this.__background = background ?? "#ffffff";
		this.__padding = padding ?? "1rem";
		this.__maxWidth = maxWidth ?? "1200px";
	}

	getBackground(): string {
		return this.__background;
	}

	getPadding(): string {
		return this.__padding;
	}

	getMaxWidth(): string {
		return this.__maxWidth;
	}

	setBackground(background: string): void {
		const writable = this.getWritable();
		writable.__background = background;
	}

	setPadding(padding: string): void {
		const writable = this.getWritable();
		writable.__padding = padding;
	}

	setMaxWidth(maxWidth: string): void {
		const writable = this.getWritable();
		writable.__maxWidth = maxWidth;
	}

	override createDOM(): HTMLDivElement {
		const div = document.createElement("div");
		div.setAttribute("data-lexical-node", "container");
		return div;
	}

	override updateDOM(): false {
		return false;
	}

	override decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
		const style: CSSProperties = {
			backgroundColor: this.__background,
			padding: this.__padding,
			maxWidth: this.__maxWidth,
			margin: "0 auto",
			minHeight: "3rem",
			border: "1px dashed var(--line, #d8d0c1)",
			borderRadius: "0.5rem",
		};

		return createElement(
			"div",
			{
				style,
				"data-drag-handle": "true",
			},
			createElement(
				"span",
				{
					style: {
						color: "var(--muted, #746b5f)",
						fontSize: "0.875rem",
					},
				},
				"Container",
			),
		);
	}

	override exportJSON(): SerializedContainerNode {
		return {
			...super.exportJSON(),
			type: "container",
			version: 1,
			background: this.__background,
			padding: this.__padding,
			maxWidth: this.__maxWidth,
		};
	}
}

export function $createContainerNode(
	background?: string,
	padding?: string,
	maxWidth?: string,
): ContainerNode {
	return $applyNodeReplacement(new ContainerNode(background, padding, maxWidth));
}
