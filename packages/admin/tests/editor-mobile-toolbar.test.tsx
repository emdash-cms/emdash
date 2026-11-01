import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { I18nProvider } from "@lingui/react";
import { RouterContextProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { ContentEditor, type FieldDescriptor } from "../src/components/ContentEditor";

import "../dist/styles.css";
import type { ContentItem } from "../src/lib/api";
import { loadMessages } from "../src/locales/loadMessages";
import { LocaleDirectionProvider } from "../src/locales/LocaleDirectionProvider.js";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const fields: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title" },
};

function item(published: boolean): ContentItem {
	return {
		id: "post-mobile",
		type: "posts",
		slug: "mobile-post",
		status: published ? "published" : "draft",
		locale: "en",
		translationGroup: null,
		data: { title: "Mobile toolbar" },
		authorId: "user-1",
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: published ? "2026-01-01T00:00:00Z" : null,
		scheduledAt: null,
		liveRevisionId: published ? "live" : null,
		draftRevisionId: published ? "live" : null,
	};
}

async function renderDirectEditor(
	entry: ContentItem,
	locale = "en",
	options: {
		saveError?: { message: string; token: number };
		supportsPreview?: boolean;
		autosave?: boolean;
		isAutosaving?: boolean;
		isNew?: boolean;
		supportsRevisions?: boolean;
	} = {},
) {
	const router = createAdminRouter(createTestQueryClient());
	const messages = locale === "en" ? {} : await loadMessages(locale);
	i18n.loadAndActivate({ locale, messages });
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<LocaleDirectionProvider>
				<Toasty>
					<RouterContextProvider router={router}>
						<ContentEditor
							collection="posts"
							collectionLabel="Post"
							fields={fields}
							item={options.isNew ? undefined : entry}
							isNew={options.isNew}
							supportsDrafts
							supportsRevisions={options.supportsRevisions}
							supportsPreview={options.supportsPreview}
							saveError={options.saveError}
							onAutosave={options.autosave ? () => undefined : undefined}
							isAutosaving={options.isAutosaving}
							onSave={() => undefined}
							onPublish={() => undefined}
							onUnpublish={() => undefined}
						/>
					</RouterContextProvider>
				</Toasty>
			</LocaleDirectionProvider>
		</I18nProvider>,
	);
	return { screen, toolbar: document.querySelector<HTMLElement>("[data-emdash-editor-bar]")! };
}

function rects(toolbar: HTMLElement) {
	return [...toolbar.querySelectorAll<HTMLElement>(":scope button, :scope a")]
		.filter((element) => element.getClientRects().length > 0)
		.map((element) => ({
			name: element.getAttribute("aria-label") ?? element.textContent?.trim(),
			rect: element.getBoundingClientRect(),
		}));
}

function expectSingleRow(toolbar: HTMLElement) {
	const buttons = rects(toolbar);
	const tops = new Set(buttons.map(({ rect }) => Math.round(rect.top + rect.height / 2)));
	expect(tops.size).toBe(1);
	expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
}

function actionGrid(toolbar: HTMLElement) {
	return toolbar.querySelector("fieldset")!.parentElement!;
}

function actionRects(toolbar: HTMLElement) {
	return rects(actionGrid(toolbar));
}

function expectFourColumnGrid(toolbar: HTMLElement) {
	const grid = actionGrid(toolbar);
	const columnWidth = grid.clientWidth / 4;
	for (const { rect } of actionRects(toolbar)) {
		expect(rect.width).toBeLessThanOrEqual(columnWidth * 2 + 1);
	}
	expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
	return grid;
}

afterEach(async () => {
	await page.viewport(1280, 800);
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("ContentEditor mobile action bar", () => {
	it("does not announce a new entry as saved", async () => {
		const { screen } = await renderDirectEditor(item(false), "en", { isNew: true });
		await expect
			.element(screen.getByRole("status").filter({ hasText: "Not saved yet" }))
			.toHaveTextContent("Not saved yet");
		expect(
			screen
				.getByRole("status")
				.filter({ hasText: /^Saved$/ })
				.query(),
		).toBeNull();
	});

	it("keeps a clean draft toolbar in a four-column mobile grid", async () => {
		await page.viewport(390, 800);
		const { toolbar } = await renderDirectEditor(item(false));
		const grid = expectFourColumnGrid(toolbar);
		const buttons = actionRects(toolbar);
		const publish = buttons.find(({ name }) => name === "Publish now" || name === "Publish");
		const settings = buttons.find(({ name }) => name === "Settings");
		const distraction = buttons.find(({ name }) => name?.startsWith("Enter distraction-free"));
		expect(publish).toBeDefined();
		expect(settings).toBeDefined();
		expect(distraction).toBeDefined();
		expect(toolbar.textContent).not.toContain("Saved");
		expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
		const gap = distraction!.rect.left - settings!.rect.right;
		expect(publish!.rect.width).toBeCloseTo(settings!.rect.width * 2 + gap, 0);
		expect(settings!.rect.width).toBeCloseTo(distraction!.rect.width, 0);
		expect(publish!.rect.top).toBeCloseTo(settings!.rect.top, 0);
		expect(grid.clientWidth).toBeGreaterThanOrEqual(toolbar.clientWidth - 24);
	});

	it("keeps autosaving actions in place while editing a draft", async () => {
		await page.viewport(390, 800);
		const { toolbar, screen } = await renderDirectEditor(item(false), "en", {
			autosave: true,
			isAutosaving: true,
			supportsRevisions: true,
		});
		const before = actionRects(toolbar).map(({ rect }) => [
			rect.x,
			rect.y,
			rect.width,
			rect.height,
		]);
		await screen.getByRole("textbox", { name: "Title" }).fill("Unsaved draft");
		expect(
			actionRects(toolbar).map(({ rect }) => [rect.x, rect.y, rect.width, rect.height]),
		).toEqual(before);
		expect(actionRects(toolbar)).toHaveLength(3);
	});

	it.each(["published-with-changes", "scheduled"])(
		"wraps %s actions without horizontal overflow",
		async (state) => {
			await page.viewport(320, 800);
			const entry =
				state === "published-with-changes"
					? { ...item(true), draftRevisionId: "changed" }
					: { ...item(false), scheduledAt: "2026-12-01T10:00:00Z" };
			const { toolbar } = await renderDirectEditor(entry);
			expectFourColumnGrid(toolbar);
			const actions = actionRects(toolbar);
			const publish = actions.find(({ name }) => name?.startsWith("Publish"))!;
			expect(publish.rect.width).toBeGreaterThan(actionGrid(toolbar).clientWidth / 4);
			for (const { rect } of actions) {
				expect(rect.left).toBeGreaterThanOrEqual(0);
				expect(rect.right).toBeLessThanOrEqual(320);
			}
		},
	);

	it("uses four equal action cells for a published post", async () => {
		await page.viewport(390, 800);
		const { toolbar } = await renderDirectEditor(item(true));
		const grid = expectFourColumnGrid(toolbar);
		const buttons = actionRects(toolbar);
		for (const name of ["Unpublish Post", "Live View", "Settings"]) {
			expect(buttons.find(({ name: found }) => found === name)).toBeDefined();
		}
		const distraction = buttons.find(({ name }) => name?.startsWith("Enter distraction-free"));
		const actionButtons = buttons.filter(
			({ name }) => name !== "Save" && name !== "Saved" && !name?.startsWith("Back to"),
		);
		expect(distraction).toBeDefined();
		expect(actionButtons).toHaveLength(4);
		expect(new Set(actionButtons.map(({ rect }) => Math.round(rect.width))).size).toBe(1);
		const byPosition = actionButtons.toSorted((a, b) => a.rect.left - b.rect.left);
		expect(byPosition.map(({ name }) => name)).toEqual([
			"Unpublish Post",
			"Live View",
			"Settings",
			"Enter distraction-free mode",
		]);
		expect(byPosition[0]!.rect.left).toBeCloseTo(grid.getBoundingClientRect().left, 0);
		expect(byPosition[3]!.rect.right).toBeCloseTo(grid.getBoundingClientRect().right, 0);
		expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
		expect(grid.clientWidth).toBeGreaterThanOrEqual(toolbar.clientWidth - 24);
	});

	it("wraps extra actions into a second row while keeping four fixed columns", async () => {
		await page.viewport(390, 800);
		const { toolbar, screen } = await renderDirectEditor(item(true), "en", {
			supportsPreview: true,
		});
		expectFourColumnGrid(toolbar);
		const buttons = actionRects(toolbar);
		expect(new Set(buttons.map(({ rect }) => Math.round(rect.top))).size).toBe(2);
		expect(new Set(buttons.map(({ rect }) => Math.round(rect.width))).size).toBe(1);
		const settings = screen.getByRole("button", { name: "Settings", exact: true }).first();
		await settings.click();
		await expect.element(screen.getByRole("button", { name: "Close settings" })).toBeVisible();
		await screen.getByRole("button", { name: "Close settings" }).click();
		await screen.getByRole("button", { name: /Enter distraction-free/ }).click();
		await expect
			.element(screen.getByRole("button", { name: /Exit distraction-free/ }))
			.toBeVisible();
	});

	it("does not wrap the desktop action row", async () => {
		await page.viewport(1280, 800);
		const { toolbar } = await renderDirectEditor(item(false));
		expectSingleRow(toolbar);
	});

	it("fits the translated publish action at 320px", async () => {
		await page.viewport(320, 800);
		const { toolbar, screen } = await renderDirectEditor(item(false), "de");
		expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
		const publish = actionRects(toolbar).find(
			({ name }) => name === "Jetzt veröffentlichen" || name === "Veröffentlichen",
		);
		expect(publish).toBeDefined();
		const publishButton = [
			...actionGrid(toolbar).querySelectorAll<HTMLElement>("button[aria-label]"),
		].find(
			(button) =>
				button.getClientRects().length > 0 && button.getAttribute("aria-label") === publish!.name,
		)!;
		const publishRect = publishButton.getBoundingClientRect();
		const visibleLabel = [...publishButton.querySelectorAll<HTMLElement>("span")].find(
			(span) =>
				span.childElementCount === 0 &&
				span.getClientRects().length > 0 &&
				Boolean(span.textContent),
		)!;
		expect(
			visibleLabel.getBoundingClientRect().left + visibleLabel.getBoundingClientRect().width / 2,
		).toBeCloseTo(publishRect.left + publishRect.width / 2, 0);
		const caret = [...publishButton.querySelectorAll<SVGElement>("svg")].at(-1)!;
		expect(caret.getBoundingClientRect().right).toBeLessThanOrEqual(publishRect.right);
		expect(publishRect.right - caret.getBoundingClientRect().right).toBeCloseTo(8, 0);
		expect(visibleLabel.getBoundingClientRect().right).toBeLessThan(
			caret.getBoundingClientRect().left,
		);
		const extendedLabel = "Veröffentlichen mit einer sehr langen Beschriftung";
		i18n.load("de", { [msg`Publish`.id!]: extendedLabel });
		await expect
			.element(
				screen
					.getByRole("button", { name: "Jetzt veröffentlichen", exact: true })
					.getByText(extendedLabel, { exact: true }),
			)
			.toBeVisible();
		const label = screen
			.getByRole("button", { name: "Jetzt veröffentlichen", exact: true })
			.getByText(extendedLabel, { exact: true })
			.element();
		expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
		expect(label.getBoundingClientRect().right).toBeLessThan(caret.getBoundingClientRect().left);
		expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
	});

	it("keeps the Arabic action row within the RTL viewport", async () => {
		await page.viewport(390, 800);
		const { toolbar } = await renderDirectEditor(item(false), "ar");
		expect(document.documentElement.dir).toBe("rtl");
		expectFourColumnGrid(toolbar);
		expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
	});

	it("shows a dismissible full-width save error below the bar on mobile and desktop", async () => {
		function SaveErrorHarness() {
			const [error, setError] = React.useState<{ message: string; token: number } | undefined>({
				message: "The server rejected this save.",
				token: 1,
			});
			return (
				<>
					<button
						type="button"
						onClick={() => setError({ message: "The server rejected this save.", token: 2 })}
					>
						Retry error
					</button>
					<button type="button" onClick={() => setError(undefined)}>
						Clear error
					</button>
					<ContentEditor
						collection="posts"
						collectionLabel="Post"
						fields={fields}
						item={item(false)}
						supportsDrafts
						saveError={error}
						onSave={() => undefined}
						onPublish={() => undefined}
						onUnpublish={() => undefined}
					/>
				</>
			);
		}

		const router = createAdminRouter(createTestQueryClient());
		const renderHarness = async () =>
			render(
				<LocaleDirectionProvider>
					<Toasty>
						<RouterContextProvider router={router}>
							<SaveErrorHarness />
						</RouterContextProvider>
					</Toasty>
				</LocaleDirectionProvider>,
			);
		await page.viewport(390, 800);
		const screen = await renderHarness();
		for (const width of [390, 1280]) {
			await page.viewport(width, 800);
			await expect
				.poll(() => {
					const toolbar = document.querySelector<HTMLElement>("[data-emdash-editor-bar]")!;
					const bannerRect = screen.getByRole("alert").element().getBoundingClientRect();
					const barRect = toolbar.getBoundingClientRect();
					return (
						barRect.width === width &&
						bannerRect.top >= barRect.bottom - 1 &&
						Math.abs(bannerRect.width - barRect.width) < 1
					);
				})
				.toBe(true);
		}
		await screen.getByRole("button", { name: "Dismiss save error" }).click();
		expect(document.querySelector('[role="alert"]')).toBeNull();
		await screen.getByRole("button", { name: "Retry error" }).click();
		await expect.element(screen.getByRole("alert")).toBeVisible();
		await screen.getByRole("button", { name: "Clear error" }).click();
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
});
