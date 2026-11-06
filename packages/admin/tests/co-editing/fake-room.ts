import { vi } from "vitest";

import type {
	DraftCapture,
	RichTextBinding,
	RoomEditing,
	RoomSaveState,
} from "../../src/lib/co-editing/types";

export const SAVED: RoomSaveState = { covered: true, saving: false, rev: "rev-1" };
export const UNSAVED: RoomSaveState = { covered: false, saving: false, rev: "rev-1" };
export const SAVING: RoomSaveState = { covered: false, saving: true, rev: "rev-1" };

/** A room's document as the editor sees it, with a way to play another client's edits. */
export function createRoom(initial: Record<string, unknown>) {
	const values = new Map(Object.entries(initial));
	const fieldListeners = new Map<string, Set<() => void>>();
	const remoteVersions = new Map<string, number>();
	const fieldSequences = new Map<string, number>();
	const saveListeners = new Set<() => void>();
	const subscriptions: string[] = [];
	const bindings = new Map<string, RichTextBinding>();
	const users = new Map<string, string>();
	let saveState = SAVED;
	let sequence = 0;

	const change = (changes: Readonly<Record<string, unknown>>) => {
		sequence++;
		for (const [field, value] of Object.entries(changes)) {
			values.set(field, value);
			fieldSequences.set(field, sequence);
		}
		for (const field of Object.keys(changes)) {
			for (const listener of fieldListeners.get(field) ?? []) listener();
		}
	};
	const setSaveState = (next: RoomSaveState) => {
		saveState = next;
		for (const listener of saveListeners) listener();
	};
	const set = vi.fn((changes: Readonly<Record<string, unknown>>) => {
		change(changes);
		setSaveState(UNSAVED);
		return true;
	});
	const whenCovered = vi.fn((_options: { save: boolean }) => Promise.resolve());
	const applyPatch = vi.fn((patch: Readonly<Record<string, unknown>>) => {
		change(patch);
		return true;
	});
	const read = (fields: readonly string[]) =>
		Object.fromEntries(fields.map((field) => [field, values.get(field) ?? null]));

	const room: RoomEditing = {
		id: "replica-1",
		fields: {
			subscribe(field, listener) {
				subscriptions.push(field);
				let listeners = fieldListeners.get(field);
				if (!listeners) fieldListeners.set(field, (listeners = new Set()));
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			get: (field) => values.get(field) ?? null,
			set,
			read,
			remoteVersion: (field) => remoteVersions.get(field) ?? 0,
		},
		subscribe(listener) {
			saveListeners.add(listener);
			return () => saveListeners.delete(listener);
		},
		getSaveState: () => saveState,
		whenCovered,
		richText(field) {
			let binding = bindings.get(field);
			if (!binding) bindings.set(field, (binding = { extensions: [] }));
			return binding;
		},
		captureDraft: (fields): DraftCapture => ({
			values: read(fields),
			rev: saveState.rev,
			sequence,
			replica: "replica-1",
		}),
		changedSince: (capture, fields) =>
			fields.some((field) => (fieldSequences.get(field) ?? 0) > capture.sequence),
		applyPatch,
		userName: (userId) => users.get(userId) ?? null,
	};

	return {
		room,
		set,
		whenCovered,
		applyPatch,
		subscriptions,
		setSaveState,
		value: (field: string) => values.get(field),
		/** Another client's change, as the replica reports it. */
		remote(changes: Record<string, unknown>) {
			for (const field of Object.keys(changes)) {
				remoteVersions.set(field, (remoteVersions.get(field) ?? 0) + 1);
			}
			change(changes);
		},
		/** A person in the room, as presence names them. */
		present(userId: string, name: string) {
			users.set(userId, name);
		},
	};
}

export type FakeRoom = ReturnType<typeof createRoom>;
