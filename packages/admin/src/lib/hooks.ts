import * as React from "react";

/**
 * Returns a stable function reference that always calls the latest version
 * of the provided callback. Useful for event listeners in effects where
 * you don't want the listener to be torn down and re-added when the
 * callback identity changes.
 */
export function useStableCallback<Args extends unknown[], Return>(
	callback: (...args: Args) => Return,
): (...args: Args) => Return {
	const ref = React.useRef(callback);
	React.useLayoutEffect(() => {
		ref.current = callback;
	});
	return React.useCallback((...args: Args) => ref.current(...args), []);
}

/**
 * Returns a debounced version of a value that only updates after the
 * specified delay has elapsed since the last change. Useful for search
 * inputs that trigger API calls.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
	const [debouncedValue, setDebouncedValue] = React.useState(value);
	React.useEffect(() => {
		const timer = setTimeout(setDebouncedValue, delay, value);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return debouncedValue;
}
