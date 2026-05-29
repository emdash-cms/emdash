import { useCallback, useMemo } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type LexicalEditor as LexicalEditorCore,
} from 'lexical';
import { ButtonNode } from './nodes/ButtonNode.js';
import { ImageNode } from './nodes/ImageNode.js';
import { ContainerNode } from './nodes/ContainerNode.js';
import { DividerNode } from './nodes/DividerNode.js';
import { SpacerNode } from './nodes/SpacerNode.js';
import { LexicalEditorContext } from './context/LexicalEditorContext.js';
import { LexicalPersistence } from './LexicalPersistence.js';
import { DragDropPlugin } from '../builder/DragDropPlugin.js';

export type { LexicalEditorCore };

export interface LexicalEditorProps {
  initialContent?: string;
  onChange?: (editorState: string) => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  renderLayout?: (editor: React.ReactNode) => React.ReactNode;
}

// LexicalErrorBoundary is imported from @lexical/react — handles React errors in the editor tree

function EditorContextBridge({ children }: { children: React.ReactNode }) {
  const [editor] = useLexicalComposerContext();
  return (
    <LexicalEditorContext.Provider value={editor}>
      {children}
    </LexicalEditorContext.Provider>
  );
}

function canParseEditorState(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { root?: unknown };
    return typeof parsed === 'object' && parsed !== null && 'root' in parsed;
  } catch {
    return false;
  }
}

export function LexicalEditor({
  initialContent,
  onChange,
  placeholder = 'Start typing...',
  className = '',
  editable = true,
  renderLayout,
}: LexicalEditorProps) {
  const handleError = useCallback((error: Error) => {
    console.error('[LexicalEditor] Error:', error);
  }, []);

  const initialConfig = useMemo(
    () => ({
      namespace: 'emdash-editor',
      editable,
      onError: handleError,
      nodes: [ButtonNode, ImageNode, ContainerNode, DividerNode, SpacerNode],
      editorState: initialContent
        ? canParseEditorState(initialContent)
          ? initialContent
          : (_editor: LexicalEditorCore) => {
              const root = $getRoot();
              if (root.isEmpty()) {
                const paragraph = $createParagraphNode();
                const textNode = $createTextNode(initialContent);
                paragraph.append(textNode);
                root.append(paragraph);
              }
          }
        : undefined,
    }),
    [editable, handleError, initialContent],
  );

  const handleChange = useCallback(
    (_editorState: unknown, editor: LexicalEditorCore, _tags: Set<string>) => {
      if (onChange) {
        const json = LexicalPersistence.serialize(editor);
        onChange(json);
      }
    },
    [onChange],
  );

  const editorElement = (
    <DragDropPlugin>
      <div className={`lexical-editor ${className}`}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="lexical-editor__content outline-none min-h-[200px] p-2"
              style={{ minHeight: '200px' }}
            />
          }
          placeholder={
            <div className="lexical-editor__placeholder text-kumo-subtle pointer-events-none absolute p-2">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        {onChange && (
          <OnChangePlugin onChange={handleChange} ignoreSelectionChange={false} />
        )}
      </div>
    </DragDropPlugin>
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <EditorContextBridge>
        {renderLayout ? renderLayout(editorElement) : editorElement}
      </EditorContextBridge>
    </LexicalComposer>
  );
}
