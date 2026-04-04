import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { render as baseRender } from "vitest-browser-react";

if (!i18n.locale) {
	i18n.loadAndActivate({ locale: "en", messages: {} });
}

function I18nWrapper({ children }: { children: React.ReactNode }) {
	return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}

export function render(ui: React.ReactElement, options?: Parameters<typeof baseRender>[1]) {
	const UserWrapper = options?.wrapper;
	const CombinedWrapper = UserWrapper
		? ({ children }: { children: React.ReactNode }) => (
				<I18nWrapper>
					<UserWrapper>{children}</UserWrapper>
				</I18nWrapper>
			)
		: I18nWrapper;
	return baseRender(ui, { ...options, wrapper: CombinedWrapper });
}
