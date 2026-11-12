import { Label } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { loadMessages } from "../../src/locales/index.js";
import { KumoTranslationsProvider } from "../../src/locales/KumoTranslationsProvider.js";

async function renderLabel(locale: string) {
	i18n.loadAndActivate({ locale, messages: await loadMessages(locale) });
	return render(
		<I18nProvider i18n={i18n}>
			<KumoTranslationsProvider>
				<Label showOptional>Title</Label>
			</KumoTranslationsProvider>
		</I18nProvider>,
	);
}

describe("KumoTranslationsProvider", () => {
	afterEach(() => {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	});

	test("shows the English optional marker for the default locale", async () => {
		const { container } = await renderLabel("en");
		expect(container.textContent).toContain("(optional)");
	});

	test("translates the optional marker Kumo renders on its own", async () => {
		const { container } = await renderLabel("zh-CN");
		expect(container.textContent).toContain("（可选）");
		expect(container.textContent).not.toContain("(optional)");
	});
});
