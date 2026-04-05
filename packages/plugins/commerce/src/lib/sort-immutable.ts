type SortableArray<T> = T[] & { toSorted(compareFn?: (left: T, right: T) => number): T[] };

export function sortedImmutable<T>(
	items: readonly T[],
	compare: (left: T, right: T) => number,
): T[] {
	const cloned = [...items];
	return (cloned as SortableArray<T>).toSorted(compare);
}

export function sortedImmutableNoCompare<T>(items: readonly T[]): T[] {
	const cloned = [...items];
	return (cloned as SortableArray<T>).toSorted();
}
