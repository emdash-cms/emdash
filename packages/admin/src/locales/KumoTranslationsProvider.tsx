import { KumoLocaleProvider } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

/** Translates the copy Kumo components render on their own, such as a dialog's Close button. */
export function KumoTranslationsProvider({ children }: { children: React.ReactNode }) {
	const { t } = useLingui();
	const close = t`Close`;
	const cancel = t`Cancel`;
	const translations = React.useMemo(() => ({ layerDialog: { close, cancel } }), [close, cancel]);
	return <KumoLocaleProvider translations={translations}>{children}</KumoLocaleProvider>;
}
