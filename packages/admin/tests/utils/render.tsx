import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { render as baseRender, type ComponentRenderOptions } from "vitest-browser-react";

type RenderWrapper = ComponentRenderOptions["wrapper"];

const ProvidersWrapper = (InnerWrapper: RenderWrapper = React.Fragment) => {
	return ({ children }: React.PropsWithChildren) => {
		const queryClient = React.useMemo(
			() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
			[],
		);
		return (
			<QueryClientProvider client={queryClient}>
				<I18nProvider i18n={i18n}>
					<InnerWrapper>{children}</InnerWrapper>
				</I18nProvider>
			</QueryClientProvider>
		);
	};
};

export const render: typeof baseRender = (ui, { wrapper: UserWrapper, ...options } = {}) => {
	return baseRender(ui, { ...options, wrapper: ProvidersWrapper(UserWrapper) });
};
