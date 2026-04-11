import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { render as baseRender, type ComponentRenderOptions } from "vitest-browser-react";

type RenderWrapper = ComponentRenderOptions["wrapper"];

const I18nWrapper = (InnerWrapper: RenderWrapper = React.Fragment) => {
	return ({ children }: React.PropsWithChildren) =>
		React.createElement(I18nProvider, { i18n }, React.createElement(InnerWrapper, null, children));
};

export const render: typeof baseRender = (ui, { wrapper: UserWrapper, ...options } = {}) => {
	return baseRender(ui, { ...options, wrapper: I18nWrapper(UserWrapper) });
};
