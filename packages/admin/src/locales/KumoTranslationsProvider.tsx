import { KumoLocaleProvider } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

/**
 * Translates the copy Kumo components render on their own: a dialog's Close and Cancel buttons, the
 * "(optional)" marker and info-icon label on form labels, and the breadcrumb trail's landmark name
 * and copy button. Kumo falls back to English for any key left out here, so keep this in step with
 * Kumo's locale table.
 */
export function KumoTranslationsProvider({ children }: { children: React.ReactNode }) {
	const { t } = useLingui();
	const close = t`Close`;
	const cancel = t`Cancel`;
	const optional = t`(optional)`;
	const moreInformation = t`More information`;
	const breadcrumb = t`Breadcrumb`;
	const copy = t`Copy`;
	const copyTooltip = t`Click to copy`;
	const translations = React.useMemo(
		() => ({
			label: { optional, tooltip: moreInformation },
			layerDialog: { close, cancel },
			breadcrumbs: { label: breadcrumb, copy, copyTooltip },
		}),
		[optional, moreInformation, close, cancel, breadcrumb, copy, copyTooltip],
	);
	return <KumoLocaleProvider translations={translations}>{children}</KumoLocaleProvider>;
}
