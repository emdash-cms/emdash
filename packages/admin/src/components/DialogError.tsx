/**
 * Shared error display for dialogs and mutation error extraction.
 */

import { cn } from "../lib/utils.js";

/** Extract a user-facing message from a mutation error value. */
export function getMutationError(error: unknown): string | null {
	if (!error) return null;
	if (error instanceof Error) return error.message;
	return "An error occurred";
}

/** Inline error banner for use inside dialogs. */
export function DialogError({
	message,
	className,
}: {
	message?: string | null;
	className?: string;
}) {
	if (!message) return null;
	const lines = message.split("\n");
	return (
		<div
			role="alert"
			className={cn("rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger", className)}
		>
			{lines.map((line, i) => (
				<div key={i}>{line}</div>
			))}
		</div>
	);
}
