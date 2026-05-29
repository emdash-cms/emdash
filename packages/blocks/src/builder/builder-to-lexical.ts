/**
 * importFromBuilderSchema — convert BuilderDocument back to Lexical state.
 *
 * This is needed when opening a saved BuilderDocument (e.g., draft revision)
 * back in the LexicalEditor for editing.
 *
 * Note: This creates a Lexical-compatible editor state that can be loaded
 * via LexicalPersistence.restore(). The Lexical nodes carry the same data
 * but lose the explicit section/columns hierarchy (Lexical doesn't model it).
 * SectionNode/ColumnsNode will be added in Phase B to fix this gap.
 *
 * TODO (Phase B): when BuilderDocument has SectionNode/ColumnsNode Lexical
 * counterparts, preserve the hierarchy here.
 */
import type { BuilderDocument } from './schema.js';
import type { SerializedEditorState } from 'lexical';

const TEXT_FORMAT_BOLD = 1;
const TEXT_FORMAT_ITALIC = 2;
const TEXT_FORMAT_STRIKETHROUGH = 4;
const TEXT_FORMAT_UNDERLINE = 8;
const TEXT_FORMAT_CODE = 16;

type PortableTextLikeNode = {
  _type?: string;
  text?: string;
  style?: string;
  level?: number;
  marks?: string[];
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  children?: PortableTextLikeNode[];
};

function createTextNode(node: PortableTextLikeNode): Record<string, unknown> {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  let format = 0;

  if (node.bold || marks.includes('strong') || marks.includes('bold')) format |= TEXT_FORMAT_BOLD;
  if (node.italic || marks.includes('em') || marks.includes('italic')) format |= TEXT_FORMAT_ITALIC;
  if (node.strikethrough || marks.includes('strike')) format |= TEXT_FORMAT_STRIKETHROUGH;
  if (node.underline || marks.includes('underline')) format |= TEXT_FORMAT_UNDERLINE;
  if (node.code || marks.includes('code')) format |= TEXT_FORMAT_CODE;

  return {
    detail: 0,
    format,
    mode: 'normal',
    style: '',
    text: node.text ?? '',
    type: 'text',
    version: 1,
  };
}

function createParagraphNode(children: PortableTextLikeNode[]): Record<string, unknown> {
  return {
    children: children.map(createTextNode),
    direction: 'ltr',
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  };
}

function portableTextNodeToLexical(node: PortableTextLikeNode): Record<string, unknown> | null {
  if (Array.isArray(node.children)) {
    return createParagraphNode(node.children);
  }

  if (typeof node.text === 'string') {
    return createParagraphNode([node]);
  }

  return null;
}

function createRootState(children: Array<Record<string, unknown>>): SerializedEditorState {
  return {
    root: {
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as SerializedEditorState;
}

/**
 * Convert a BuilderDocument to a Lexical-compatible serialized editor state
 * that can be loaded via editor.parseEditorState().
 *
 * Returns null if the document is empty/invalid.
 */
export function importFromBuilderSchema(
  doc: BuilderDocument | null | undefined,
): SerializedEditorState | null {
  if (!doc || !Array.isArray(doc.blocks) || doc.blocks.length === 0) {
    return null;
  }

  // Collect all non-section/non-columns blocks from the document tree
  const blocks = flattenBuilderBlocks(doc.blocks);

  const lexicalChildren = blocks.map((block) => builderBlockToLexical(block));

  // Filter out nulls (unknown block types)
  const validChildren = lexicalChildren.filter(Boolean);

  if (validChildren.length === 0) {
    return null;
  }

  return createRootState(validChildren);
}

/**
 * Convert existing Portable Text arrays into a Lexical-compatible serialized
 * editor state. This lets the visual builder open old content instead of
 * showing raw JSON text in the editor.
 */
export function importPortableTextToLexicalState(
  value: unknown,
): SerializedEditorState | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const children = value
    .map((node) => portableTextNodeToLexical(node as PortableTextLikeNode))
    .filter((node): node is Record<string, unknown> => Boolean(node));

  if (children.length === 0) {
    return null;
  }

  return createRootState(children);
}

function builderBlockToLexical(block: {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  children?: any[];
}): // eslint-disable-next-line @typescript-eslint/no-explicit-any
any | null {
  switch (block.type) {
    case 'button':
      return {
        version: 1,
        type: 'button',
        text: block.props?.text ?? 'Button',
        variant: block.props?.variant ?? 'primary',
        size: block.props?.size ?? 'medium',
        indent: 0,
        direction: 'ltr',
        format: '',
      };

    case 'image':
      return {
        version: 1,
        type: 'image',
        src: block.props?.src ?? '',
        alt: block.props?.alt ?? '',
        width: block.props?.width ?? '100%',
        alignment: block.props?.alignment ?? 'center',
        indent: 0,
        direction: 'ltr',
        format: '',
      };

    case 'container':
      return {
        version: 1,
        type: 'container',
        background: block.props?.background ?? '#ffffff',
        padding: block.props?.padding ?? '1rem',
        maxWidth: block.props?.maxWidth ?? '1200px',
        indent: 0,
        direction: 'ltr',
        format: '',
      };

    case 'spacer':
      return {
        version: 1,
        type: 'spacer',
        height: block.props?.height ?? '2rem',
        indent: 0,
        direction: 'ltr',
        format: '',
      };

    case 'divider':
      return {
        version: 1,
        type: 'divider',
        indent: 0,
        direction: 'ltr',
        format: '',
      };

    case 'richText':
      return {
        version: 1,
        type: 'paragraph',
        children: (block.content ?? [])
          .flatMap((node: PortableTextLikeNode) =>
            Array.isArray(node.children) ? node.children : [node],
          )
          .map(createTextNode),
        indent: 0,
        direction: 'ltr',
        format: '',
        textFormat: 0,
        textStyle: '',
      };

    default:
      return null;
  }
}

/**
 * Recursively flatten a BuilderDocument block tree into a list,
 * extracting leaf blocks from section/columns wrappers.
 * eslint-disable-next-line @typescript-eslint/no-explicit-any
 */
function flattenBuilderBlocks(blocks: any[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any[] = [];
  for (const block of blocks) {
    if (block.type === 'section') {
      // Section wraps children directly (no columns)
      if (Array.isArray(block.children)) {
        result.push(...flattenBuilderBlocks(block.children));
      }
    } else if (block.type === 'columns') {
      // Columns has explicit columns[]
      if (Array.isArray(block.columns)) {
        for (const col of block.columns) {
          if (Array.isArray(col.blocks)) {
            result.push(...flattenBuilderBlocks(col.blocks));
          }
        }
      }
    } else {
      // Leaf block
      result.push(block);
    }
  }
  return result;
}
