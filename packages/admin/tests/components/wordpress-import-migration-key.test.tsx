import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WordPressImport } from "../../src/components/WordPressImport.js";
import { render } from "../utils/render.tsx";
import { createMockFetch, TestWrapper } from "../utils/test-helpers.tsx";

const ANALYZE_URL = "/_emdash/api/import/wordpress-plugin/analyze";

function makeMigrationKey(payload: { url: string; user: string; pass: string }) {
	// eslint-disable-next-line no-restricted-globals
	return `em1.${btoa(JSON.stringify(payload))}`;
}

describe("WordPressImport migration key flow", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch.on("GET", "/_emdash/api/users", { data: { items: [] } });
		if (!i18n.locale) {
			i18n.loadAndActivate({ locale: "en", messages: {} });
		}
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("shows the analyze error and retry controls when a migration key analyze fails", async () => {
		mockFetch.on("POST", ANALYZE_URL, { error: { code: "FORBIDDEN", message: "Forbidden" } }, 403);

		const key = makeMigrationKey({
			url: "https://wp.example.com",
			user: "admin",
			pass: "app password",
		});

		const screen = await render(
			<I18nProvider i18n={i18n}>
				<WordPressImport />
			</I18nProvider>,
			{ wrapper: TestWrapper },
		);

		await expect.element(screen.getByText("Paste your migration key")).toBeVisible();

		await screen.getByLabelText("Migration key").fill(key);
		await screen.getByRole("button", { name: "Connect" }).click();

		await expect.element(screen.getByText("Forbidden")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Back" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Connect & Analyze" })).toBeVisible();
		await expect.element(screen.getByLabelText("WordPress Username")).toHaveValue("admin");
	});

	it("explains how to let EmDash through when bot protection challenges the analyze request", async () => {
		mockFetch.on(
			"POST",
			ANALYZE_URL,
			{ error: { code: "WP_SITE_CHALLENGE", message: "challenge" } },
			502,
		);

		const key = makeMigrationKey({
			url: "https://wp.example.com",
			user: "admin",
			pass: "app password",
		});

		const screen = await render(
			<I18nProvider i18n={i18n}>
				<WordPressImport />
			</I18nProvider>,
			{ wrapper: TestWrapper },
		);

		await screen.getByLabelText("Migration key").fill(key);
		await screen.getByRole("button", { name: "Connect" }).click();

		await expect
			.element(screen.getByText(/Allow requests to \/wp-json\/emdash\/v1\//))
			.toBeVisible();
	});

	it("explains how to let EmDash through when bot protection challenges the URL check", async () => {
		mockFetch.on("POST", "/_emdash/api/import/probe", {
			data: {
				result: {
					url: "https://wp.example.com",
					isWordPress: false,
					bestMatch: null,
					allMatches: [],
					challenged: true,
				},
			},
		});

		const screen = await render(
			<I18nProvider i18n={i18n}>
				<WordPressImport />
			</I18nProvider>,
			{ wrapper: TestWrapper },
		);

		await screen.getByLabelText("Enter your WordPress site URL").fill("https://wp.example.com");
		await screen.getByRole("button", { name: "Check Site" }).click();

		await expect.element(screen.getByText("Bot protection blocked the connection")).toBeVisible();
		await expect
			.element(screen.getByText(/Allow requests to \/wp-json\/emdash\/v1\//))
			.toBeVisible();
	});
});
