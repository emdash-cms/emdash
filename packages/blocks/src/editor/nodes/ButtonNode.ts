import { createElement, type ReactNode } from 'react';
import { DecoratorNode } from 'lexical';
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { $applyNodeReplacement } from 'lexical';

export type ButtonVariant = 'primary' | 'secondary' | 'outline';
export type ButtonSize = 'small' | 'medium' | 'large';

export type SerializedButtonNode = Spread<
  {
    type: 'button';
    version: 1;
    variant: ButtonVariant;
    size: ButtonSize;
    text: string;
  },
  SerializedLexicalNode
>;

export class ButtonNode extends DecoratorNode<ReactNode> {
  __variant: ButtonVariant;
  __size: ButtonSize;
  __text: string;

  static override getType(): string {
    return 'button';
  }

  static override clone(node: ButtonNode, key?: NodeKey): ButtonNode {
    return new ButtonNode(node.__text, node.__variant, node.__size, key);
  }

  static override importJSON(serialized: SerializedButtonNode): ButtonNode {
    return new ButtonNode(serialized.text, serialized.variant, serialized.size);
  }

  constructor(
    text: string,
    variant?: ButtonVariant,
    size?: ButtonSize,
    key?: NodeKey,
  ) {
    super(key);
    this.__text = text;
    this.__variant = variant ?? 'primary';
    this.__size = size ?? 'medium';
  }

  getVariant(): ButtonVariant {
    return this.__variant;
  }

  getSize(): ButtonSize {
    return this.__size;
  }

  setText(text: string): void {
    const writable = this.getWritable();
    writable.__text = text;
  }

  setVariant(variant: ButtonVariant): void {
    const writable = this.getWritable();
    writable.__variant = variant;
  }

  setSize(size: ButtonSize): void {
    const writable = this.getWritable();
    writable.__size = size;
  }

  override getTextContent(): string {
    return this.__text;
  }

  override createDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-lexical-node', 'button');
    return wrapper;
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return createElement(
      'a',
      {
        className: `btn btn-${this.__variant} btn-${this.__size}`,
        href: '#',
        'data-drag-handle': 'true',
        onClick: (event) => event.preventDefault(),
      },
      this.__text,
    );
  }

  override exportJSON(): SerializedButtonNode {
    return {
      ...super.exportJSON(),
      type: 'button',
      version: 1,
      variant: this.__variant,
      size: this.__size,
      text: this.__text,
    };
  }
}

export function $createButtonNode(
  text: string,
  variant?: ButtonVariant,
  size?: ButtonSize,
): ButtonNode {
  return $applyNodeReplacement(new ButtonNode(text, variant, size));
}
