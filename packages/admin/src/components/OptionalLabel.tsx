import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

/**
 * A field label followed by a muted "(optional)" marker. Kumo's own
 * `showOptional` / `required={false}` marker is hard-coded English, so
 * pass this as a Kumo `label` instead.
 */
export function OptionalLabel({ children }: { children: ReactNode }) {
	const { t } = useLingui();
	return (
		<>
			{children} <span className="font-normal text-kumo-subtle">{t`(optional)`}</span>
		</>
	);
}
