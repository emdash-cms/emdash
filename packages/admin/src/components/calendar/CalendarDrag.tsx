import {
	DndContext,
	DragOverlay,
	MouseSensor,
	TouchSensor,
	pointerWithin,
	useDroppable,
	useSensor,
	useSensors,
	type Active,
	type DragEndEvent,
	type DragMoveEvent,
	type Over,
} from "@dnd-kit/core";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import {
	minutesInZone,
	zonedInstant,
	type CalendarDisplay,
	type CalendarItem,
} from "../../lib/calendar.js";
import { CalendarEntryChipPreview } from "./CalendarEntry.js";

interface DropTarget {
	day: string;
}

interface DragState {
	item: CalendarItem;
	/** Where it would land if dropped now. */
	time?: number;
	allowed: boolean;
}

function readItem(active: Active): CalendarItem | undefined {
	return active.data.current?.item as CalendarItem | undefined;
}

function readTarget(over: Over | null): DropTarget | undefined {
	return over?.data.current as DropTarget | undefined;
}

interface CalendarDragProviderProps {
	display: CalendarDisplay;
	now: number;
	/** Called with the new time when an entry is dropped on another day. */
	onMove: (item: CalendarItem, scheduledAt: string) => void;
	/** Called when an entry is dropped on a time that has passed. */
	onPastDrop: () => void;
	children: React.ReactNode;
}

/** Lets scheduled entries be dropped on another day in the month. */
export function CalendarDragProvider({
	display,
	now,
	onMove,
	onPastDrop,
	children,
}: CalendarDragProviderProps) {
	const { t } = useLingui();
	// On touch screens a drag starts with a long press, so swipes still scroll.
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
	);
	const [drag, setDrag] = React.useState<DragState | null>(null);

	const landing = (event: DragMoveEvent): number | undefined => {
		const item = readItem(event.active);
		const target = readTarget(event.over);
		if (!item || !target) return undefined;
		if (target.day === item.day) return item.time;
		return zonedInstant(target.day, minutesInZone(item.time, display.timeZone), display.timeZone);
	};

	const titleOf = (active: Active) => readItem(active)?.title ?? "";
	const accessibility = {
		announcements: {
			onDragStart: ({ active }: { active: Active }) => {
				const title = titleOf(active);
				return t`Picked up ${title}.`;
			},
			onDragOver: ({ active, over }: { active: Active; over: Over | null }) => {
				const title = titleOf(active);
				const target = readTarget(over);
				if (!target) return t`${title} is not over a day.`;
				const date = display.fullDate(target.day);
				return t`${title} is over ${date}.`;
			},
			onDragEnd: ({ active, over }: { active: Active; over: Over | null }) => {
				const title = titleOf(active);
				const target = readTarget(over);
				if (!target) return t`${title} was dropped outside the calendar.`;
				const date = display.fullDate(target.day);
				return t`${title} was dropped on ${date}.`;
			},
			onDragCancel: ({ active }: { active: Active }) => {
				const title = titleOf(active);
				return t`Moving ${title} was cancelled.`;
			},
		},
		screenReaderInstructions: {
			draggable: t`To reschedule an entry with the keyboard, open it and choose Reschedule.`,
		},
	};

	const update = (event: DragMoveEvent) => {
		const time = landing(event);
		setDrag((current) =>
			current
				? {
						...current,
						time,
						allowed: time !== undefined && time !== current.item.time && time > Date.now(),
					}
				: current,
		);
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={pointerWithin}
			accessibility={accessibility}
			onDragStart={(event) => {
				const item = readItem(event.active);
				if (item) setDrag({ item, allowed: false });
			}}
			onDragMove={update}
			onDragOver={update}
			onDragCancel={() => setDrag(null)}
			onDragEnd={(event: DragEndEvent) => {
				const item = readItem(event.active);
				const time = landing(event);
				setDrag(null);
				if (!item || time === undefined || time === item.time) return;
				if (time <= Date.now()) {
					onPastDrop();
					return;
				}
				onMove(item, new Date(time).toISOString());
			}}
		>
			{children}
			<DragOverlay dropAnimation={null}>
				{drag && (
					<CalendarEntryChipPreview
						item={{ ...drag.item, time: drag.time ?? drag.item.time }}
						display={display}
						now={now}
						allowed={drag.allowed}
					/>
				)}
			</DragOverlay>
		</DndContext>
	);
}

/** Makes a month cell a place to drop entries; days before today aren't. */
export function useCalendarDrop(day: string, today: string) {
	const target: DropTarget = { day };
	const { setNodeRef, isOver, active } = useDroppable({
		id: `day:${day}`,
		data: target,
		disabled: day < today,
	});
	return { ref: setNodeRef, highlighted: isOver && active !== null };
}
