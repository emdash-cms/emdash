/**
 * Shared error display for dialogs and mutation error extraction.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import * as React from "react";

import { cn } from "../lib/utils.js";

/** Extract a user-facing message from a mutation error value. */
export function getMutationError(error: unknown): string | null {
	if (!error) return null;
	if (error instanceof Error) return error.message;
	return i18n._(msg`An error occurred`);
}

/** Inline error banner for use inside dialogs. */
export function DialogError({
	message,
	className,
}: {
	message?: string | null;
	className?: string;
}) {
	const ref = React.useRef<HTMLDivElement>(null);
	// The banner sits at the end of a dialog's scrolling body, which the
	// pinned actions that raised it can leave scrolled out of view.
	React.useEffect(() => {
		if (!message) return;
		ref.current?.scrollIntoView({ block: "nearest" });
		// The control that started the request was disabled while it ran, which
		// drops focus out of the dialog. Bring it back to the dialog.
		if (document.activeElement === document.body) {
			ref.current?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')?.focus();
		}
	}, [message]);

	if (!message) return null;
	const lines = message.split("\n");
	return (
		<div
			ref={ref}
			role="alert"
			className={cn("rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger", className)}
		>
			{lines.map((line, i) => (
				<div key={i}>{line}</div>
			))}
		</div>
	);
}
