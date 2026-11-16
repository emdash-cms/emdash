import * as React from "react";

import { ADMIN_BUILD } from "../admin-build.js";
import type { AdminManifest } from "../api/client.js";
import { joinRoom, saveRecoveryRevision, type RoomEntry } from "../api/rooms.js";
import {
	createCoEditingSession,
	type CoEditingSession,
	type SessionDeps,
	type SessionOptions,
} from "./session.js";
import { createTransportHealth } from "./transport-health.js";
import type { CoEditing, PresenceUser, RoomEditing, RoomEvent, RoomSaveState } from "./types.js";

const PENDING: CoEditing = { mode: "pending", waiting: false };
const NO_USERS: readonly PresenceUser[] = Object.freeze([]);

export interface UseCoEditingOptions {
	collection: string;
	entryId: string;
	locale?: string;
	/** The session pins the first manifest it gets. Later ones don't change it. */
	manifest: AdminManifest | undefined;
	onEvent(event: RoomEvent): void;
}

/** One session per entry and locale, started once the manifest has loaded. */
export function useCoEditing(options: UseCoEditingOptions): CoEditing {
	const { collection, entryId, locale, manifest } = options;
	const onEventRef = React.useRef(options.onEvent);
	onEventRef.current = options.onEvent;
	const manifestRef = React.useRef(manifest);
	manifestRef.current = manifest;
	const identity = `${collection}:${entryId}:${locale ?? ""}`;
	const [started, setStarted] = React.useState<{
		identity: string;
		session: CoEditingSession;
	} | null>(null);
	const ready = manifest !== undefined;

	React.useEffect(() => {
		const pinned = manifestRef.current;
		if (!pinned) return;
		const entry: RoomEntry = { collection, id: entryId, locale };
		const created = createCoEditingSession(
			browserDeps(entry, (event) => onEventRef.current(event)),
			sessionOptions(pinned, collection),
		);
		setStarted({ identity, session: created });
		return () => {
			created.dispose();
			setStarted((current) => (current?.session === created ? null : current));
		};
	}, [collection, entryId, identity, locale, ready]);

	// Until the effect replaces it, the session in state is the previous entry's.
	const session = started?.identity === identity ? started.session : null;
	return React.useSyncExternalStore(
		session?.subscribe ?? subscribeToNothing,
		session?.getView ?? pendingView,
	);
}

export function useRoomSaveState(room: RoomEditing | null): RoomSaveState | null {
	return React.useSyncExternalStore(
		room?.subscribe ?? subscribeToNothing,
		room ? room.getSaveState : nothing,
	);
}

/** One field's value in the room's document, re-rendering only when that field changes. */
export function useRoomFieldValue(room: RoomEditing | null, field: string | null): unknown {
	const subscribe = React.useCallback(
		(listener: () => void) =>
			room && field !== null ? room.fields.subscribe(field, listener) : () => {},
		[room, field],
	);
	const read = React.useCallback(
		() => (room && field !== null ? room.fields.get(field) : undefined),
		[room, field],
	);
	return React.useSyncExternalStore(subscribe, read);
}

/**
 * The other people in the room, or those in `field`. Re-renders only when someone joins, leaves
 * or changes field, never when a cursor moves.
 */
export function useRoomPeers(room: RoomEditing | null, field?: string): readonly PresenceUser[] {
	const read = React.useCallback(
		() => (room ? room.presence.getUsers(field) : NO_USERS),
		[room, field],
	);
	return React.useSyncExternalStore(room?.presence.subscribe ?? subscribeToNothing, read);
}

/** Tells the room which user this tab belongs to, before the first paint, so colors never shift. */
export function useRoomSelf(room: RoomEditing | null, userId: string | null): void {
	React.useLayoutEffect(() => {
		room?.presence.setSelf(userId);
	}, [room, userId]);
}

/**
 * A key that changes after another client changes the field, for editors that read their value
 * once. While focus is inside `scope` it waits until focus leaves, so a remount never takes the
 * field away from someone using it. Call it where the field's value is subscribed, so a remote
 * change re-renders the caller.
 */
export function useRemountKey(
	room: RoomEditing,
	field: string,
	enabled: boolean,
	scope: React.RefObject<HTMLElement | null>,
): number {
	const remoteVersion = room.fields.remoteVersion(field);
	const [key, setKey] = React.useState(remoteVersion);
	React.useEffect(() => {
		const element = scope.current;
		if (!enabled || key === remoteVersion || !element) return;
		if (!element.contains(document.activeElement)) {
			setKey(remoteVersion);
			return;
		}
		const onFocusOut = (event: FocusEvent) => {
			if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) {
				setKey(room.fields.remoteVersion(field));
			}
		};
		element.addEventListener("focusout", onFocusOut);
		return () => element.removeEventListener("focusout", onFocusOut);
	}, [enabled, key, remoteVersion, room, field, scope]);
	return key;
}

function sessionOptions(manifest: AdminManifest, collection: string): SessionOptions {
	const fields = manifest.collections[collection]?.fields ?? {};
	return {
		manifest,
		fingerprint: { version: ADMIN_BUILD.version, commit: ADMIN_BUILD.commit, hash: manifest.hash },
		richTextFields: Object.entries(fields)
			.filter(([, field]) => field.kind === "portableText")
			.map(([slug]) => slug),
		pluginBlockTypes: Object.values(manifest.plugins).flatMap(
			(plugin) => plugin.portableTextBlocks?.map((block) => block.type) ?? [],
		),
	};
}

function browserDeps(entry: RoomEntry, onEvent: (event: RoomEvent) => void): SessionDeps {
	return {
		join: (request) => joinRoom(entry, request),
		saveRecovery: (input) => saveRecoveryRevision(entry, input),
		loadReplicaModule: () => import("./replica/index.js"),
		openSocket: (url) => new WebSocket(url),
		health: createTransportHealth(),
		reload: () => window.location.reload(),
		clock: {
			now: () => Date.now(),
			setTimeout: (callback, ms) => window.setTimeout(callback, ms),
			clearTimeout(handle) {
				if (typeof handle === "number") window.clearTimeout(handle);
			},
		},
		online: () => navigator.onLine,
		listenNetwork(listener) {
			const online = () => listener(true);
			const offline = () => listener(false);
			window.addEventListener("online", online);
			window.addEventListener("offline", offline);
			return () => {
				window.removeEventListener("online", online);
				window.removeEventListener("offline", offline);
			};
		},
		onEvent,
	};
}

function subscribeToNothing(): () => void {
	return () => {};
}

function pendingView(): CoEditing {
	return PENDING;
}

function nothing(): null {
	return null;
}
