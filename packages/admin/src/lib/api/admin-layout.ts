/**
 * The personal sidebar layout as the admin reads and saves it.
 *
 * Two layers, merged only when read:
 *
 * - accepted: the `["currentUser"]` cache, what the server last confirmed.
 *   Refetches and resets may rewrite it at any time.
 * - pending: this module's save queue, what the user asked for and the server
 *   hasn't confirmed yet. Only the queue writes it.
 *
 * Readers see `pending ?? accepted`. Dropping `pending` on a failed save is
 * what restores the last layout the server accepted, and a refetch during a
 * save can't undo the user's change because it only touches `accepted`.
 */

import { useKumoToastManager } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	arrangeEditor,
	arrangeNav,
	EMPTY_LIST_LAYOUT,
	isCustomized,
	moveEditorSection,
	moveNavEntry,
	parseAdminLayout,
	replaceList,
	setHidden,
	toStoredAdminLayout,
	type AdminLayout,
	type ArrangedNavGroup,
	type ArrangedRow,
	type LayoutNavGroup,
	type LayoutScope,
	type ListLayout,
} from "../admin-layout.js";
import { apiFetch, throwResponseError } from "./client.js";
import {
	currentUserQueryKey,
	currentUserQueryOptions,
	useCurrentUser,
	type CurrentUser,
} from "./current-user.js";

/** At most one save in flight and one waiting. */
export interface SaveQueue {
	readonly inFlight: AdminLayout | null;
	/** Only the latest change waits; each new change replaces it. */
	readonly queued: AdminLayout | null;
}

export type SaveQueueEvent =
	| { readonly type: "change"; readonly layout: AdminLayout }
	| { readonly type: "saved" }
	| { readonly type: "failed"; readonly error: Error };

export interface SaveQueueStep {
	readonly queue: SaveQueue;
	/** Start this save now. */
	readonly send: AdminLayout | null;
	/** The server just confirmed this layout. */
	readonly accepted: AdminLayout | null;
}

export const IDLE_SAVE_QUEUE: SaveQueue = { inFlight: null, queued: null };

/** What readers show over the accepted layout, or `null` when nothing is unsaved. */
export function pendingLayout(queue: SaveQueue): AdminLayout | null {
	return queue.queued ?? queue.inFlight;
}

/**
 * Every save replaces the whole layout, so a failure retries nothing: readers
 * fall back to the accepted layout, which is the last one the server took.
 */
export function stepSaveQueue(queue: SaveQueue, event: SaveQueueEvent): SaveQueueStep {
	switch (event.type) {
		case "change":
			if (queue.inFlight) {
				return {
					queue: { ...queue, queued: event.layout },
					send: null,
					accepted: null,
				};
			}
			return {
				queue: { inFlight: event.layout, queued: null },
				send: event.layout,
				accepted: null,
			};
		case "saved":
			if (!queue.inFlight) return { queue, send: null, accepted: null };
			return {
				queue: { inFlight: queue.queued, queued: null },
				send: queue.queued,
				accepted: queue.inFlight,
			};
		case "failed":
			return { queue: IDLE_SAVE_QUEUE, send: null, accepted: null };
	}
}

async function postAdminLayout(layout: AdminLayout): Promise<void> {
	const response = await apiFetch("/_emdash/api/auth/me", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "setAdminLayout", adminLayout: toStoredAdminLayout(layout) }),
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to save sidebar layout`));
}

/**
 * One per QueryClient, because it writes into that client's cache. It lives
 * outside React, so a save queued just before the user leaves the page is
 * still sent.
 */
class AdminLayoutStore {
	#queue: SaveQueue = IDLE_SAVE_QUEUE;
	readonly #listeners = new Set<() => void>();
	readonly #queryClient: QueryClient;
	#onFailure: ((error: Error) => void) | null = null;

	constructor(queryClient: QueryClient) {
		this.#queryClient = queryClient;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	getSnapshot = (): SaveQueue => this.#queue;

	/** The effective layout, read at call time so edits in one tick compose. */
	current(): AdminLayout {
		const user = this.#queryClient.getQueryData<CurrentUser>(currentUserQueryKey);
		return pendingLayout(this.#queue) ?? parseAdminLayout(user?.adminLayout);
	}

	/** Apply `change` to one list of the effective layout and save it. Returns the list it was given. */
	edit(scope: LayoutScope, change: (list: ListLayout) => ListLayout): ListLayout {
		const layout = this.current();
		const next = replaceList(layout, scope, change(layout[scope]));
		if (next !== layout) this.#dispatch({ type: "change", layout: next });
		return layout[scope];
	}

	/** The latest handler reports every later failure, even after its page unmounted. */
	setFailureHandler(handler: (error: Error) => void): void {
		this.#onFailure = handler;
	}

	#dispatch(event: SaveQueueEvent): void {
		const step = stepSaveQueue(this.#queue, event);
		// Accepted before pending, in one tick, so no render sees the old accepted layout.
		if (step.accepted) {
			const adminLayout = toStoredAdminLayout(step.accepted);
			this.#queryClient.setQueryData<CurrentUser>(
				currentUserQueryKey,
				(user) => user && { ...user, adminLayout },
			);
		}
		if (step.queue !== this.#queue) {
			this.#queue = step.queue;
			for (const listener of this.#listeners) listener();
		}
		if (event.type === "failed") this.#onFailure?.(event.error);
		if (step.send) void this.#send(step.send);
	}

	async #send(layout: AdminLayout): Promise<void> {
		try {
			await postAdminLayout(layout);
		} catch (error) {
			this.#dispatch({
				type: "failed",
				error: error instanceof Error ? error : new Error(String(error)),
			});
			return;
		}
		// A refetch that read the row before this write committed would otherwise
		// land after `saved` and put the old layout back.
		await this.#queryClient.cancelQueries({ queryKey: currentUserQueryKey, exact: true });
		this.#dispatch({ type: "saved" });
	}
}

const STORES = Symbol.for("emdash.admin.adminLayoutStores");

function storeFor(queryClient: QueryClient): AdminLayoutStore {
	const holder = globalThis as typeof globalThis & {
		[STORES]?: WeakMap<QueryClient, AdminLayoutStore>;
	};
	const registry = (holder[STORES] ??= new WeakMap<QueryClient, AdminLayoutStore>());
	let store = registry.get(queryClient);
	if (!store) {
		store = new AdminLayoutStore(queryClient);
		registry.set(queryClient, store);
	}
	return store;
}

/**
 * The layout every sidebar renders: unsaved changes over the server's copy.
 * Referentially stable until either layer changes, so it can feed a memoized
 * component.
 */
export function useAdminLayout(): AdminLayout {
	const store = storeFor(useQueryClient());
	const queue = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
	const raw = useCurrentUser().data?.adminLayout;
	const accepted = React.useMemo(() => parseAdminLayout(raw), [raw]);
	return pendingLayout(queue) ?? accepted;
}

export interface AdminLayoutEditorInput<
	TNav extends { id: string },
	TSection extends { id: string },
> {
	/** The navigation as the user can see it. Keep the identity stable between renders. */
	readonly navGroups: readonly LayoutNavGroup<TNav>[];
	/** Every editor section the user can see in some collection. Keep the identity stable. */
	readonly editorSections: readonly TSection[];
}

export interface AdminLayoutEditor<TNav extends { id: string }, TSection extends { id: string }> {
	/**
	 * False until the reload of the current user this hook starts on mount
	 * succeeds; edits are ignored until then. True at once when a save from an
	 * earlier visit is still running. Once true, it stays true.
	 */
	readonly ready: boolean;
	/** Why the mount reload failed, while that keeps the editor from being ready. */
	readonly reloadError: Error | null;
	/** Start the mount reload again. */
	retry(): void;
	/** The Navigation list: every entry the user can see, hidden ones flagged. */
	readonly nav: readonly ArrangedNavGroup<TNav>[];
	/** The Editor list, hidden ones flagged. */
	readonly editor: readonly ArrangedRow<TSection>[];
	readonly customized: Readonly<Record<LayoutScope, boolean>>;
	setVisible(scope: LayoutScope, id: string, visible: boolean): void;
	move(scope: LayoutScope, activeId: string, overId: string): void;
	/** Restore the list's default; returns an Undo that puts the previous list back. */
	reset(scope: LayoutScope): () => void;
}

const noop = () => {};

export function useAdminLayoutEditor<TNav extends { id: string }, TSection extends { id: string }>({
	navGroups,
	editorSections,
}: AdminLayoutEditorInput<TNav, TSection>): AdminLayoutEditor<TNav, TSection> {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const store = storeFor(useQueryClient());
	const layout = useAdminLayout();
	const [savingAtMount] = React.useState(() => store.getSnapshot().inFlight !== null);
	const reload = useQuery({ ...currentUserQueryOptions(), refetchOnMount: "always" });
	// A failed background refetch keeps the data but sets `isSuccess` to false.
	const [reloaded, setReloaded] = React.useState(false);
	if (!reloaded && reload.isFetchedAfterMount && reload.isSuccess) setReloaded(true);
	const ready = savingAtMount || reloaded;
	const reloadError = ready ? null : reload.error;
	const { refetch } = reload;
	const retry = React.useCallback(() => void refetch(), [refetch]);

	React.useEffect(() => {
		store.setFailureHandler((error) => {
			toastManager.add({
				title: t`Couldn't save your sidebars`,
				description: error.message,
				variant: "error",
			});
		});
	}, [store, t, toastManager]);

	const nav = React.useMemo(() => arrangeNav(navGroups, layout.nav), [navGroups, layout.nav]);
	const editor = React.useMemo(
		() => arrangeEditor(editorSections, layout.editor),
		[editorSections, layout.editor],
	);
	const customized = React.useMemo(
		() => ({ nav: isCustomized(layout.nav), editor: isCustomized(layout.editor) }),
		[layout.nav, layout.editor],
	);

	const actions = React.useMemo(() => {
		const edit = (scope: LayoutScope, change: (list: ListLayout) => ListLayout) => {
			if (ready) store.edit(scope, change);
		};
		return {
			setVisible: (scope: LayoutScope, id: string, visible: boolean) =>
				edit(scope, (list) => setHidden(scope, list, id, !visible)),
			move: (scope: LayoutScope, activeId: string, overId: string) =>
				edit(scope, (list) =>
					scope === "nav"
						? moveNavEntry(navGroups, list, activeId, overId)
						: moveEditorSection(editorSections, list, activeId, overId),
				),
			reset: (scope: LayoutScope) => {
				if (!ready) return noop;
				const previous = store.edit(scope, (list) =>
					isCustomized(list) ? EMPTY_LIST_LAYOUT : list,
				);
				return () => {
					store.edit(scope, () => previous);
				};
			},
		};
	}, [store, ready, navGroups, editorSections]);

	return { ready, reloadError, retry, nav, editor, customized, ...actions };
}
