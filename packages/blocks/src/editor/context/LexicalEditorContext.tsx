import { createContext, useContext, type Context } from 'react';
import type { LexicalEditor } from 'lexical';

export const LexicalEditorContext: Context<LexicalEditor | null> = createContext<LexicalEditor | null>(null);

export function useLexicalEditorContext(): LexicalEditor {
  const editor = useContext(LexicalEditorContext);
  if (!editor) {
    throw new Error('useLexicalEditorContext must be used within LexicalEditorProvider');
  }
  return editor;
}
