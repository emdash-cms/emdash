import type {
	Announcements,
	DragCancelEvent,
	DragEndEvent,
	DragOverEvent,
	DragStartEvent,
} from "@dnd-kit/core";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

const silent = () => undefined;
const SILENT_ANNOUNCEMENTS: Announcements = {
	onDragStart: silent,
	onDragOver: silent,
	onDragEnd: silent,
	onDragCancel: silent,
};

/**
 * Props for a sortable list's `DndContext` that announce a drag politely, through the list's own
 * live region, in the editor's language and by the rows' names, in place of dnd-kit's
 * announcements. `onMove` makes the move a drop asks for.
 */
export function useDragAnnouncements({
	keys,
	nameOf,
	announce,
	onMove,
}: {
	keys: readonly string[];
	nameOf: (key: string) => string;
	announce: (message: string) => void;
	onMove: (from: number, to: number) => void;
}) {
	const { t } = useLingui();
	const overRef = React.useRef<string | null>(null);
	const total = keys.length;
	const notMoved = (key: string) => {
		const name = nameOf(key);
		announce(t`${name} was not moved`);
	};
	return {
		accessibility: {
			announcements: SILENT_ANNOUNCEMENTS,
			screenReaderInstructions: { draggable: "" },
		},
		onDragStart: ({ active }: DragStartEvent) => {
			const key = String(active.id);
			overRef.current = key;
			const name = nameOf(key);
			const position = keys.indexOf(key) + 1;
			announce(t`Picked up ${name}, position ${position} of ${total}`);
		},
		onDragOver: ({ active, over }: DragOverEvent) => {
			if (!over || String(over.id) === overRef.current) return;
			overRef.current = String(over.id);
			const name = nameOf(String(active.id));
			const position = keys.indexOf(String(over.id)) + 1;
			announce(t`${name} is over position ${position} of ${total}`);
		},
		onDragEnd: ({ active, over }: DragEndEvent) => {
			const key = String(active.id);
			const from = keys.indexOf(key);
			const to = over ? keys.indexOf(String(over.id)) : -1;
			if (from < 0 || to < 0 || from === to) {
				notMoved(key);
				return;
			}
			const name = nameOf(key);
			onMove(from, to);
			const position = to + 1;
			announce(t`Moved ${name} to position ${position} of ${total}`);
		},
		onDragCancel: ({ active }: DragCancelEvent) => notMoved(String(active.id)),
	};
}
