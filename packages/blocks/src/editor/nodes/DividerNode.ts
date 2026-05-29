import { createElement, type ReactNode } from 'react';
import { DecoratorNode } from 'lexical';
import type { EditorConfig, LexicalEditor, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import { $applyNodeReplacement } from 'lexical';

export type SerializedDividerNode = Spread<
  {
    type: 'divider';
    version: 1;
  },
  SerializedLexicalNode
>;

export class DividerNode extends DecoratorNode<ReactNode> {
  static override getType(): string {
    return 'divider';
  }

  static override clone(_node: DividerNode, key?: NodeKey): DividerNode {
    return new DividerNode(key);
  }

  static override importJSON(_serialized: SerializedDividerNode): DividerNode {
    return new DividerNode();
  }

  override createDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-lexical-node', 'divider');
    return wrapper;
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return createElement('hr', {
      style: {
        border: 'none',
        borderTop: '1px solid var(--line, #d8d0c1)',
        margin: '1rem 0',
      },
      'data-drag-handle': 'true',
    });
  }

  override exportJSON(): SerializedDividerNode {
    return {
      ...super.exportJSON(),
      type: 'divider',
      version: 1,
    };
  }
}

export function $createDividerNode(): DividerNode {
  return $applyNodeReplacement(new DividerNode());
}
