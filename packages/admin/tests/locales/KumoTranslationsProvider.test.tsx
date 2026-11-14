import { Label } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { I18nProvider } from "@lingui/react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { KumoTranslationsProvider } from "../../src/locales/KumoTranslationsProvider.js";

// The messages the provider hands to Kumo. Looking the ids up with `msg` keeps this test independent
// of any locale's catalog.
const messages = {
	[msg`(optional)`.id!]: "(译:可选)",
	[msg`More information`.id!]: "译:更多信息",
};

function renderLabel(locale: string) {
	i18n.loadAndActivate({ locale, messages: locale === "en" ? {} : messages });
	return render(
		<I18nProvider i18n={i18n}>
			<KumoTranslationsProvider>
				<Label showOptional tooltip="Help text">
					Title
				</Label>
			</KumoTranslationsProvider>
		</I18nProvider>,
	);
}

describe("KumoTranslationsProvider", () => {
	afterEach(() => {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	});

	test("keeps Kumo's English copy for the default locale", () => {
		const { container } = renderLabel("en");
		expect(container.textContent).toContain("(optional)");
		expect(screen.getByRole("button", { name: "More information" })).toBeTruthy();
	});

	test("translates the optional marker Kumo renders on its own", () => {
		const { container } = renderLabel("xx");
		expect(container.textContent).toContain("(译:可选)");
		expect(container.textContent).not.toContain("(optional)");
	});

	test("translates the label of the info-icon button", () => {
		renderLabel("xx");
		expect(screen.getByRole("button", { name: "译:更多信息" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "More information" })).toBeNull();
	});
});
