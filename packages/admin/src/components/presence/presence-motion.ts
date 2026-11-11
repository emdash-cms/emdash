import * as React from "react";

/** How long a person's avatar or pill takes to leave, as long as they take to enter. */
const LEAVE_MS = 150;

export interface Shown<T> {
	readonly item: T;
	/** Removed, and drawn only while its exit transition runs. */
	readonly leaving: boolean;
}

/**
 * What to draw for `items`: each of them, and each one just removed, kept in its place and marked
 * leaving until its exit transition ends. Removed items go at once under reduced motion, and when
 * keeping them would draw more than `capacity` items.
 */
export function useLeavingItems<T extends { readonly id: string }>(
	items: readonly T[],
	capacity = Infinity,
): readonly Shown<T>[] {
	const [state, setState] = React.useState(() => ({ items, shown: arrived(items) }));
	let { shown } = state;
	if (state.items !== items) {
		shown = withLeaving(state.shown, items);
		if (prefersReducedMotion() || shown.length > capacity) shown = arrived(items);
		setState({ items, shown });
	}
	const leaving = shown.some((entry) => entry.leaving);
	React.useEffect(() => {
		if (!leaving) return;
		const timer = setTimeout(
			() =>
				setState((current) => ({
					...current,
					shown: current.shown.filter((entry) => !entry.leaving),
				})),
			LEAVE_MS,
		);
		return () => clearTimeout(timer);
	}, [leaving, shown]);
	return shown;
}

/**
 * False on the first render and true after it, so what a page opens with appears without an
 * entrance and only later arrivals animate in.
 */
export function useAfterFirstPaint(): boolean {
	const [painted, setPainted] = React.useState(false);
	React.useEffect(() => setPainted(true), []);
	return painted;
}

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function arrived<T>(items: readonly T[]): Shown<T>[] {
	return items.map((item) => ({ item, leaving: false }));
}

function withLeaving<T extends { readonly id: string }>(
	previous: readonly Shown<T>[],
	items: readonly T[],
): Shown<T>[] {
	const present = new Set(items.map((item) => item.id));
	const next = arrived(items);
	previous.forEach((entry, index) => {
		if (present.has(entry.item.id)) return;
		next.splice(Math.min(index, next.length), 0, { item: entry.item, leaving: true });
	});
	return next;
}
