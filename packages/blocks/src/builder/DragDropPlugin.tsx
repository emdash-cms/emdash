import {
	DndContext,
	DragOverlay,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragStartEvent,
} from "@dnd-kit/core";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $getRoot, type EditorState } from "lexical";
/**
 * Drag-and-drop for Lexical editor nodes using dnd-kit DragOverlay.
 *
 * Architecture:
 * - DragDropPlugin wraps the editor content (provides DndContext)
 * - useSortable attaches to the editor content div (single sortable item = the editor)
 * - DragOverlay renders the dragged node's visual during the drag
 * - On drag-end: cursor Y position relative to editor content → target index
 *   → Lexical $getNodeByKey + remove/insertAt to reorder
 *
 * nodeKeysArray[index] = nodeKey, synced to Lexical root child order.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const CUSTOM_NODE_TYPES = ["button", "image", "container", "divider", "spacer"] as const;
type CustomNodeType = (typeof CUSTOM_NODE_TYPES)[number];

export interface DragDropPluginProps {
	children: React.ReactNode;
	onDragStart?: (activeId: string) => void;
	onDragEnd?: (activeId: string, overId: string) => void;
}

interface DragState {
	activeId: string;
	activeIndex: number;
	activeNodeType: string;
}

/** Returns the index in root children at which to insert, given a cursor Y. */
function cursorYToInsertIndex(cursorY: number, rootEl: HTMLElement): number {
	const children = rootEl.children;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!child) continue;
		const rect = child.getBoundingClientRect();
		const midY = rect.top + rect.height / 2;
		if (cursorY < midY) return i;
	}
	return children.length;
}

export function DragDropPlugin({ children, onDragStart, onDragEnd }: DragDropPluginProps) {
	const [editor] = useLexicalComposerContext();
	const [nodeKeysArray, setNodeKeysArray] = useState<string[]>([]);
	const [dragState, setDragState] = useState<DragState | null>(null);
	const rootElRef = useRef<HTMLElement | null>(null);

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	// Sync nodeKeysArray to Lexical root child order
	useEffect(() => {
		const sync = (editorState: EditorState = editor.getEditorState()) => {
			const keys = editorState.read(() =>
				$getRoot()
					.getChildren()
					.filter((n) => CUSTOM_NODE_TYPES.includes(n.getType() as CustomNodeType))
					.map((n) => n.getKey()),
			);
			setNodeKeysArray(keys);
		};
		sync();
		return editor.registerUpdateListener(({ editorState }) => sync(editorState));
	}, [editor]);

	// Get editor root element
	useEffect(() => {
		rootElRef.current = editor.getRootElement();
	});

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			const activeId = String(event.active.id);
			const activeIndex = nodeKeysArray.indexOf(activeId);
			if (activeIndex < 0) return;
			const activeNodeType = editor.getEditorState().read(() => {
				const node = $getNodeByKey(activeId);
				return node?.getType() ?? "unknown";
			});
			setDragState({
				activeId,
				activeIndex,
				activeNodeType,
			});
			onDragStart?.(activeId);
		},
		[editor, nodeKeysArray, onDragStart],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			if (!dragState || !rootElRef.current) {
				setDragState(null);
				return;
			}

			const { activeId } = dragState;
			const overId = event.over?.id ? String(event.over.id) : null;
			let targetIndex: number;

			if (overId && nodeKeysArray.includes(overId)) {
				targetIndex = nodeKeysArray.indexOf(overId);
			} else {
				// No over-id → use cursor position
				const rootRect = rootElRef.current.getBoundingClientRect();
				const clientY =
					event.activatorEvent instanceof MouseEvent
						? event.activatorEvent.clientY
						: (event.over?.rect.top ?? rootRect.top) +
							(event.over?.rect.height ?? rootRect.height) / 2;
				targetIndex = cursorYToInsertIndex(clientY, rootElRef.current);
			}

			const activeKey = activeId;
			const targetKey = nodeKeysArray[targetIndex];

			if (activeKey && targetKey && activeKey !== targetKey) {
				editor.update(
					() => {
						const activeNode = $getNodeByKey(activeKey);
						if (!activeNode) return;
						const root = $getRoot();
						const targetRefNode = root.getChildAtIndex(targetIndex);
						if (targetRefNode) {
							targetRefNode.insertAfter(activeNode);
						} else {
							root.append(activeNode);
						}
					},
					{ discrete: true },
				);
			}

			setDragState(null);
			onDragEnd?.(activeId, overId ?? String(targetIndex));
		},
		[dragState, nodeKeysArray, editor, onDragEnd],
	);

	// DragOverlay content: label of dragged node type
	const overlayContent = dragState ? (
		<div className="lexical-drag-overlay">
			<span className="lexical-drag-overlay__label">{dragState.activeNodeType}</span>
		</div>
	) : null;

	return (
		<DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
			{children}
			<DragOverlay dropAnimation={null}>{overlayContent}</DragOverlay>
		</DndContext>
	);
}
