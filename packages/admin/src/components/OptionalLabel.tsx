import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

/**
 * A field label followed by a muted "(optional)" marker, for labels the admin builds itself: the
 * image and avatar pickers and the read-only revision view have no Kumo control to turn the marker
 * on, and the byline form passes it as the `label` node. Kumo's own marker (`showOptional` /
 * `required={false}`) is translated through `KumoTranslationsProvider`, so both read the same.
 */
export function OptionalLabel({ children }: { children: ReactNode }) {
	const { t } = useLingui();
	return (
		<>
			{children} <span className="font-normal text-kumo-subtle">{t`(optional)`}</span>
		</>
	);
}
