import type { LayerDialog } from "@cloudflare/kumo";
import * as React from "react";
import { flushSync } from "react-dom";

import { useStableCallback } from "./hooks.js";

type LayerDialogRootProps = React.ComponentProps<typeof LayerDialog.Root>;

/**
 * Moves focus to the first field in `form`, in reading order, that shows an
 * error. Call it once the errors have rendered, so the field is announced with
 * its message; `revealErrors` does both in one event.
 *
 * An input marks itself with `aria-invalid`. A Kumo `Select` keeps aria
 * attributes off its trigger, so mark an element around it with
 * `data-field-invalid` instead.
 */
export function focusFirstInvalid(form: HTMLFormElement | null): void {
	const field = form?.querySelector<HTMLElement>('[aria-invalid="true"], [data-field-invalid]');
	if (!field) return;
	const control = field.hasAttribute("data-field-invalid")
		? field.querySelector<HTMLElement>("button, input, textarea, [tabindex]")
		: field;
	control?.focus();
}

/** Renders the errors `update` turns on, then focuses the first field that shows one. */
export function revealErrors(form: HTMLFormElement | null, update: () => void): void {
	flushSync(update);
	focusFirstInvalid(form);
}

/**
 * Props for `LayerDialog.Root` that keep a stray press outside, or a swipe down
 * on the phone sheet, from throwing away what the user typed. Cancel and
 * Escape still close the dialog.
 */
export function guardUnsavedInput(
	unsaved: boolean,
	onOpenChange: (open: boolean) => void,
): Pick<LayerDialogRootProps, "disablePointerDismissal" | "onOpenChange"> {
	return {
		disablePointerDismissal: unsaved,
		onOpenChange: (open, details) => {
			if (!open && unsaved && details.reason === "swipe") {
				details.cancel();
				return;
			}
			onOpenChange(open);
		},
	};
}

/**
 * State for a `ConfirmDialog` whose request can fail: the dialog stays open
 * while the request runs, shows its failure, and closes once it resolves.
 * Spread `dialog` onto the `ConfirmDialog` and call `show` to open it.
 */
export function useConfirmedRequest(request: (() => Promise<unknown> | void) | undefined) {
	const [open, setOpen] = React.useState(false);
	const [isPending, setIsPending] = React.useState(false);
	const [error, setError] = React.useState<unknown>(null);
	return {
		show: () => {
			setError(null);
			setOpen(true);
		},
		dialog: {
			open,
			isPending,
			error,
			onClose: () => setOpen(false),
			onConfirm: () => {
				setIsPending(true);
				setError(null);
				// The executor turns a request that throws before returning into a
				// rejection; Promise.resolve(request()) would let it escape.
				void new Promise((resolve) => resolve(request?.()))
					.then(
						() => setOpen(false),
						(requestError: unknown) => setError(requestError),
					)
					.finally(() => setIsPending(false));
			},
		},
	};
}

/**
 * Wraps a submit so that calling it again while its last run is in flight does
 * nothing. Both clicks of a double click can land before a mutation's pending
 * state renders, so `disabled={isPending}` alone can send the request twice.
 *
 * Pass a mutation's `mutateAsync`: a rejection is ignored here because the
 * mutation's own `error` already reports it.
 */
export function useSingleFlight<Args extends unknown[]>(
	submit: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
	const inFlight = React.useRef(false);
	const run = useStableCallback(submit);
	return React.useCallback(
		(...args: Args) => {
			if (inFlight.current) return;
			inFlight.current = true;
			void run(...args)
				.catch(() => {})
				.finally(() => {
					inFlight.current = false;
				});
		},
		[run],
	);
}
