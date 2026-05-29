import { createElement, type ReactNode } from 'react';
import { DecoratorNode } from 'lexical';
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { $applyNodeReplacement } from 'lexical';

export type SerializedSpacerNode = Spread<
  {
    type: 'spacer';
    version: 1;
    height: string;
  },
  SerializedLexicalNode
>;

export class SpacerNode extends DecoratorNode<ReactNode> {
  __height: string;

  static override getType(): string {
    return 'spacer';
  }

  static override clone(node: SpacerNode, key?: NodeKey): SpacerNode {
    return new SpacerNode(node.__height, key);
  }

  static override importJSON(serialized: SerializedSpacerNode): SpacerNode {
    return new SpacerNode(serialized.height);
  }

  constructor(height?: string, key?: NodeKey) {
    super(key);
    this.__height = height ?? '2rem';
  }

  getHeight(): string {
    return this.__height;
  }

  setHeight(height: string): void {
    const writable = this.getWritable();
    writable.__height = height;
  }

  override createDOM(): HTMLDivElement {
    const div = document.createElement('div');
    div.setAttribute('data-lexical-node', 'spacer');
    return div;
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return createElement('div', {
      'aria-hidden': 'true',
      'data-drag-handle': 'true',
      style: {
        height: this.__height,
        width: '100%',
      },
    });
  }

  override exportJSON(): SerializedSpacerNode {
    return {
      ...super.exportJSON(),
      type: 'spacer',
      version: 1,
      height: this.__height,
    };
  }
}

export function $createSpacerNode(height?: string): SpacerNode {
  return $applyNodeReplacement(new SpacerNode(height));
}
