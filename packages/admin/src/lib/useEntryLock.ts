import * as React from "react";

import {
	acquireEntryLock,
	entryLockRefusal,
	releaseEntryLock,
	type EntryLockHolder,
	type EntryLockStatus,
} from "./api/entry-lock.js";

export type EntryLockState =
	/** The first acquire has not answered yet. */
	| { status: "pending" }
	/** The collection does not take edit locks. */
	| { status: "disabled" }
	/**
	 * The lock could not be taken. The editor stays open and keeps trying; the
	 * write path still refuses a conflicting save.
	 */
	| { status: "unreachable" }
	/** This session holds the lock. */
	| { status: "holding" }
	/** Someone else holds it and the editor has not chosen what to do. */
	| { status: "blocked"; holder: EntryLockHolder }
	/** Someone else holds it and the editor chose to read. */
	| { status: "reading"; holder: EntryLockHolder }
	/** Someone else now holds the lock this session had, by take-over or after the lease lapsed. */
	| { status: "taken"; holder: EntryLockHolder };

export interface EntryLock {
	state: EntryLockState;
	/** Whether the editor must not accept edits. */
	readOnly: boolean;
	takeOver: () => void;
	readInstead: () => void;
	isTakingOver: boolean;
	/**
	 * Report a failed write. Returns true when the lock explains the failure,
	 * which also switches the editor to read-only. `entryId` is the entry the
	 * write was for; a refusal for any other entry is left to the caller.
	 */
	reportWriteError: (error: unknown, entryId: string) => boolean;
}

/**
 * How often a session re-asserts its lease. Well inside the server's lease,
 * so a pause in typing does not lose the entry, and coarse enough to fire
 * under the once-a-minute timer throttling browsers apply to background tabs.
 */
export const ENTRY_LOCK_HEARTBEAT_MS = 2 * 60 * 1000;

const IDLE: EntryLockState = { status: "pending" };

function sessionToken(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

export function useEntryLock(input: {
	collection: string;
	entryId: string;
	locale?: string;
	/** Hold off until the entry has loaded and the id is known to resolve. */
	ready: boolean;
}): EntryLock {
	const { collection, entryId, locale, ready } = input;
	const [state, setState] = React.useState<EntryLockState>(IDLE);
	const [isTakingOver, setIsTakingOver] = React.useState(false);
	// Release only what this session actually took, so a read-only viewer
	// never drops the holder's lock on the way out.
	const holdsLockRef = React.useRef(false);
	// The editor stays mounted across an entry or locale switch, so an answer
	// that was asked for before the switch must not land on what is open now.
	const generationRef = React.useRef(0);
	// One token per mounted editor, so two tabs of the same account are told
	// apart on release.
	const tokenRef = React.useRef("");
	if (!tokenRef.current) tokenRef.current = sessionToken();
	const stateRef = React.useRef(state);
	stateRef.current = state;
	const scheduleHeartbeatRef = React.useRef<() => void>(() => {});

	const commit = React.useCallback((next: EntryLockState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	React.useEffect(() => {
		if (!ready) return;

		generationRef.current += 1;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const token = tokenRef.current;
		commit(IDLE);
		setIsTakingOver(false);
		holdsLockRef.current = false;

		// Returns whether the heartbeat should carry on.
		const apply = (status: EntryLockStatus): boolean => {
			if (!status.enabled) {
				holdsLockRef.current = false;
				commit({ status: "disabled" });
				return false;
			}
			if (status.heldByCaller || !status.holder) {
				holdsLockRef.current = status.heldByCaller;
				commit({ status: "holding" });
				return true;
			}
			holdsLockRef.current = false;
			const previous = stateRef.current.status;
			const holder = status.holder;
			if (previous === "holding" || previous === "taken") {
				commit({ status: "taken", holder });
				return false;
			}
			commit(
				previous === "reading" ? { status: "reading", holder } : { status: "blocked", holder },
			);
			return true;
		};

		const schedule = () => {
			if (timer) clearTimeout(timer);
			if (cancelled) return;
			timer = setTimeout(() => void beat(), ENTRY_LOCK_HEARTBEAT_MS);
		};
		scheduleHeartbeatRef.current = schedule;

		const beat = async () => {
			if (cancelled) return;
			const current = stateRef.current.status;
			if (current === "disabled" || current === "taken") return;
			try {
				const status = await acquireEntryLock(collection, entryId, { locale, token });
				if (cancelled) {
					// The editor moved on while this was in flight; hand back what it took.
					if (status.heldByCaller) {
						void releaseEntryLock(collection, entryId, { locale, token }).catch(() => undefined);
					}
					return;
				}
				if (apply(status)) schedule();
			} catch {
				if (cancelled) return;
				if (stateRef.current.status === "pending") commit({ status: "unreachable" });
				schedule();
			}
		};

		// Timers are suspended while a tab is hidden or the machine sleeps, so
		// the lease is re-checked as soon as the tab is looked at again.
		const onVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			if (timer) clearTimeout(timer);
			void beat();
		};
		const onPageHide = () => {
			if (!holdsLockRef.current) return;
			holdsLockRef.current = false;
			void releaseEntryLock(collection, entryId, { locale, token, keepalive: true }).catch(
				() => undefined,
			);
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pagehide", onPageHide);
		void beat();

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pagehide", onPageHide);
			scheduleHeartbeatRef.current = () => {};
			if (!holdsLockRef.current) return;
			holdsLockRef.current = false;
			void releaseEntryLock(collection, entryId, { locale, token }).catch(() => undefined);
		};
	}, [collection, entryId, locale, ready, commit]);

	const takeOver = React.useCallback(() => {
		const generation = generationRef.current;
		const token = tokenRef.current;
		setIsTakingOver(true);
		void (async () => {
			try {
				const status = await acquireEntryLock(collection, entryId, {
					locale,
					takeover: true,
					token,
				});
				if (!status.heldByCaller) return;
				if (generation !== generationRef.current) {
					// The editor moved on while the take-over was in flight. Hand back
					// what it just took rather than holding a lock nobody is using.
					await releaseEntryLock(collection, entryId, { locale, token }).catch(() => undefined);
					return;
				}
				holdsLockRef.current = true;
				commit({ status: "holding" });
				scheduleHeartbeatRef.current();
			} catch {
				// Leave the notice standing; the editor can try again.
			} finally {
				if (generation === generationRef.current) setIsTakingOver(false);
			}
		})();
	}, [collection, entryId, locale, commit]);

	const readInstead = React.useCallback(() => {
		if (stateRef.current.status !== "blocked") return;
		commit({ status: "reading", holder: stateRef.current.holder });
	}, [commit]);

	const reportWriteError = React.useCallback(
		(error: unknown, writtenEntryId: string) => {
			const holder = entryLockRefusal(error);
			if (!holder || writtenEntryId !== entryId) return false;
			holdsLockRef.current = false;
			commit({ status: "taken", holder });
			return true;
		},
		[entryId, commit],
	);

	return {
		state,
		readOnly: state.status === "blocked" || state.status === "reading" || state.status === "taken",
		takeOver,
		readInstead,
		isTakingOver,
		reportWriteError,
	};
}
