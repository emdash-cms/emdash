import * as React from "react";

const objectIs =
	typeof Object.is === "function"
		? Object.is
		: (x, y) => (x === y && (x !== 0 || 1 / x === 1 / y)) || (x !== x && y !== y);

export function useSyncExternalStoreWithSelector(
	subscribe,
	getSnapshot,
	getServerSnapshot,
	selector,
	isEqual,
) {
	const instRef = React.useRef(null);
	if (instRef.current === null) {
		instRef.current = { hasValue: false, value: null };
	}
	const inst = instRef.current;

	const [getSelection, getServerSelection] = React.useMemo(() => {
		let hasMemo = false;
		let memoizedSnapshot;
		let memoizedSelection;

		const memoizedSelector = (nextSnapshot) => {
			if (!hasMemo) {
				hasMemo = true;
				memoizedSnapshot = nextSnapshot;
				const nextSelection = selector(nextSnapshot);
				if (isEqual !== undefined && inst.hasValue) {
					const currentSelection = inst.value;
					if (isEqual(currentSelection, nextSelection)) {
						memoizedSelection = currentSelection;
						return currentSelection;
					}
				}
				memoizedSelection = nextSelection;
				return nextSelection;
			}

			const previousSelection = memoizedSelection;
			if (objectIs(memoizedSnapshot, nextSnapshot)) {
				return previousSelection;
			}

			const nextSelection = selector(nextSnapshot);
			if (isEqual !== undefined && isEqual(previousSelection, nextSelection)) {
				memoizedSnapshot = nextSnapshot;
				return previousSelection;
			}

			memoizedSnapshot = nextSnapshot;
			memoizedSelection = nextSelection;
			return nextSelection;
		};

		return [
			() => memoizedSelector(getSnapshot()),
			getServerSnapshot === undefined ? undefined : () => memoizedSelector(getServerSnapshot()),
		];
	}, [getSnapshot, getServerSnapshot, selector, isEqual]);

	const value = React.useSyncExternalStore(subscribe, getSelection, getServerSelection);
	React.useEffect(() => {
		inst.hasValue = true;
		inst.value = value;
	}, [inst, value]);
	React.useDebugValue(value);
	return value;
}
