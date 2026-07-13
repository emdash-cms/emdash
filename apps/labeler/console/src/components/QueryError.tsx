import { Banner } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";

export interface QueryErrorProps {
	title: string;
	error: unknown;
}

/**
 * Shared error presentation for a failed query. No retry machinery — once
 * the console talks to a real API a reload is enough to retry, and this
 * scaffold never mutates state a retry button would need to redo.
 */
export function QueryError({ title, error }: QueryErrorProps) {
	const detail = error instanceof Error ? error.message : "An unexpected error occurred.";
	return (
		<Banner
			variant="error"
			icon={<WarningCircle className="h-5 w-5" />}
			title={title}
			description={`${detail} Try reloading the page.`}
		/>
	);
}
