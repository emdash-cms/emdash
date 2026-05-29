import { useState, useCallback, useEffect } from 'react';
import { useLexicalEditorContext } from '../editor/context/LexicalEditorContext.js';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  type NodeKey,
} from 'lexical';
import { ButtonNode } from '../editor/nodes/ButtonNode.js';
import { ImageNode } from '../editor/nodes/ImageNode.js';
import { SpacerNode } from '../editor/nodes/SpacerNode.js';

interface PropertyDefinition {
  key: string;
  label: string;
  type: 'text' | 'select';
  options?: string[];
}

const PROPERTY_DEFINITIONS: Record<string, PropertyDefinition[]> = {
  button: [
    { key: 'text', label: 'Text', type: 'text' },
    {
      key: 'variant',
      label: 'Variant',
      type: 'select',
      options: ['primary', 'secondary', 'outline'],
    },
    {
      key: 'size',
      label: 'Size',
      type: 'select',
      options: ['small', 'medium', 'large'],
    },
  ],
  image: [
    { key: 'src', label: 'Image URL', type: 'text' },
    {
      key: 'alignment',
      label: 'Alignment',
      type: 'select',
      options: ['left', 'center', 'right'],
    },
  ],
  spacer: [{ key: 'height', label: 'Height', type: 'text' }],
};

function getPropertyValues(node: ButtonNode | ImageNode | SpacerNode): Record<string, string> {
  if (node instanceof ButtonNode) {
    return {
      text: node.getTextContent(),
      variant: node.getVariant(),
      size: node.getSize(),
    };
  }
  if (node instanceof ImageNode) {
    return {
      src: node.getSrc(),
      alignment: node.getAlignment(),
    };
  }
  if (node instanceof SpacerNode) {
    return {
      height: node.getHeight(),
    };
  }
  return {};
}

export function PropertyPanel() {
  const editor = useLexicalEditorContext();
  const [selectedKey, setSelectedKey] = useState<NodeKey | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const listener = () => {
      const selection = $getSelection();
      if (!$isNodeSelection(selection)) {
        setSelectedKey(null);
        setSelectedType(null);
        return false;
      }
      const cachedNodes = selection.getCachedNodes();
      if (!cachedNodes || cachedNodes.length === 0) {
        setSelectedKey(null);
        setSelectedType(null);
        return false;
      }
      const firstNode = cachedNodes[0];
      if (!firstNode) {
        setSelectedKey(null);
        setSelectedType(null);
        return false;
      }
      const key = firstNode.getKey();
      const type = firstNode.getType();
      if (PROPERTY_DEFINITIONS[type]) {
        setSelectedKey(key);
        setSelectedType(type);
        setValues(getPropertyValues(firstNode as ButtonNode | ImageNode | SpacerNode));
      }
      return false;
    };

    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      listener,
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  const handleChange = useCallback(
    (key: string, value: string) => {
      setValues((prev) => ({ ...prev, [key]: value }));

      if (!selectedKey) return;

      editor.update(() => {
        const node = $getNodeByKey(selectedKey);
        if (!node) return;

        if (node instanceof ButtonNode) {
          switch (key) {
            case 'text':
              node.setText(value);
              break;
            case 'variant':
              node.setVariant(value as 'primary' | 'secondary' | 'outline');
              break;
            case 'size':
              node.setSize(value as 'small' | 'medium' | 'large');
              break;
          }
          return;
        }

        if (node instanceof ImageNode) {
          switch (key) {
            case 'src':
              node.setSrc(value);
              break;
            case 'alignment':
              node.setAlignment(value as 'left' | 'center' | 'right');
              break;
          }
          return;
        }

        if (node instanceof SpacerNode) {
          if (key === 'height') {
            node.setHeight(value);
          }
          return;
        }
      });
    },
    [editor, selectedKey],
  );

  const props = selectedType ? PROPERTY_DEFINITIONS[selectedType] ?? [] : [];

  return (
    <div className="flex flex-col gap-4 p-4 min-w-[260px]">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle">
          Inspector
        </p>
        <p className="mt-1 text-sm font-medium text-kumo-text capitalize">
          {selectedType ? `${selectedType} Properties` : 'No Selection'}
        </p>
      </div>

      {!selectedType && (
        <div className="rounded-md border border-dashed border-kumo-line bg-kumo-muted p-4">
          <p className="text-sm font-medium text-kumo-text">Select a block</p>
          <p className="mt-1 text-xs leading-5 text-kumo-subtle">
            Click a visual block on the canvas to edit its properties here.
          </p>
        </div>
      )}

      {props.map((prop) => (
        <div key={prop.key} className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-kumo-subtle" htmlFor={`prop-${prop.key}`}>
            {prop.label}
          </label>
          {prop.type === 'select' ? (
            <select
              id={`prop-${prop.key}`}
              value={values[prop.key] ?? ''}
              onChange={(e) => handleChange(prop.key, e.target.value)}
              className="h-9 rounded-md border border-kumo-line bg-kumo-bg px-2 text-sm text-kumo-text outline-none focus:ring-2 focus:ring-kumo-ring"
            >
              {prop.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`prop-${prop.key}`}
              type="text"
              value={values[prop.key] ?? ''}
              onChange={(e) => handleChange(prop.key, e.target.value)}
              className="h-9 rounded-md border border-kumo-line bg-kumo-bg px-2 text-sm text-kumo-text outline-none focus:ring-2 focus:ring-kumo-ring"
            />
          )}
        </div>
      ))}
    </div>
  );
}
