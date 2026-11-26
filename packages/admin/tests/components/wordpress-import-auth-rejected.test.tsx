import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WordPressImport } from "../../src/components/WordPressImport.js";
import { render } from "../utils/render.tsx";
import { createMockFetch, TestWrapper } from "../utils/test-helpers.tsx";

describe("WordPressImport rejected connection", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;
	let originalUrl: string;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch.on("GET", "/_emdash/api/users", { data: { items: [] } });
		if (!i18n.locale) {
			i18n.loadAndActivate({ locale: "en", messages: {} });
		}
		originalUrl = window.location.href;
	});

	afterEach(() => {
		mockFetch.restore();
		window.history.replaceState({}, "", originalUrl);
	});

	it("shows the rejection and a way to reconnect when the page loads after a rejected callback", async () => {
		window.history.replaceState({}, "", `${window.location.pathname}?error=auth_rejected`);

		const screen = await render(
			<I18nProvider i18n={i18n}>
				<WordPressImport />
			</I18nProvider>,
			{ wrapper: TestWrapper },
		);

		await expect
			.element(
				screen.getByText("WordPress did not approve the connection, or the approval expired."),
			)
			.toBeVisible();
		await expect.element(screen.getByLabelText("Migration key")).toBeVisible();
		expect(window.location.search).toBe("");
	});
});
