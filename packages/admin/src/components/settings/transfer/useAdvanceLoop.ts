import * as React from "react";

export interface AdvanceStep {
	nextRequestInMs: number | null;
}

/**
 * Drive a server-side operation by calling `step` until it returns
 * `nextRequestInMs: null`, waiting the suggested delay between calls. Pauses
 * while the page is hidden and resumes when it is shown again. A failed step
 * stops the loop; bump `resumeToken` to try again.
 */
export function useAdvanceLoop<T extends AdvanceStep>({
	key,
	step,
	onStep,
	onError,
	resumeToken = 0,
}: {
	/** The operation being driven, or null when nothing should run. */
	key: string | null;
	step: () => Promise<T>;
	onStep: (result: T) => void;
	onError: (error: unknown) => void;
	resumeToken?: number;
}): void {
	const [visible, setVisible] = React.useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	const callbacks = React.useRef({ step, onStep, onError });
	callbacks.current = { step, onStep, onError };

	React.useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);

	React.useEffect(() => {
		if (key === null || !visible) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let wake: (() => void) | undefined;
		const wait = (ms: number) =>
			new Promise<void>((resolve) => {
				wake = resolve;
				timer = setTimeout(resolve, ms);
			});
		void (async () => {
			for (;;) {
				let result: T;
				try {
					result = await callbacks.current.step();
				} catch (error) {
					if (!cancelled) callbacks.current.onError(error);
					return;
				}
				if (cancelled) return;
				callbacks.current.onStep(result);
				if (result.nextRequestInMs === null) return;
				if (result.nextRequestInMs > 0) await wait(result.nextRequestInMs);
				if (cancelled) return;
			}
		})();
		return () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
			wake?.();
		};
	}, [key, visible, resumeToken]);
}
