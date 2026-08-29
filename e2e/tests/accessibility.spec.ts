/**
 * Accessibility E2E Tests
 *
 * Automated WCAG 2.1 AA audit using axe-core.
 * Tests for critical and high-priority accessibility issues across admin pages.
 */

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { test, expect } from "../fixtures";

// Regex patterns for URL assertions (anchored to prevent false matches)
const ADMIN_ROOT_URL = /\/_emdash\/admin\/?(?:[?#].*)?$/;
const CONTENT_POSTS_URL = /\/content\/posts\/?(?:[?#].*)?$/;
const CONTENT_POSTS_NEW_URL = /\/content\/posts\/new\/?(?:[?#].*)?$/;
const MEDIA_URL = /\/media\/?(?:[?#].*)?$/;
const USERS_URL = /\/users\/?(?:[?#].*)?$/;
const SETTINGS_URL = /\/settings\/?(?:[?#].*)?$/;

// Known a11y violations from upstream dependencies:
// - color-contrast: kumo design system colors on white backgrounds (needs upstream fix)
// - aria-valid-attr-value: Base UI's Collapsible sets aria-controls on triggers pointing
//   to panel IDs that may not be in the DOM when collapsed (kumo Sidebar collapsible groups)
const KNOWN_A11Y_EXCLUSIONS = ["color-contrast", "aria-valid-attr-value"];

async function beginPointerDrag(page: Page, source: Locator, target: Locator) {
	const sourceBox = await source.boundingBox();
	const targetBox = await target.boundingBox();
	if (!sourceBox || !targetBox) throw new Error("Drag source or target is not visible");
	await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		sourceBox.x + sourceBox.width / 2 + 12,
		sourceBox.y + sourceBox.height / 2,
		{
			steps: 2,
		},
	);
	await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
		steps: 8,
	});
	await page.locator("[data-media-drag-overlay]").waitFor();
	await page.mouse.move(targetBox.x + targetBox.width / 2 + 1, targetBox.y + targetBox.height / 2);
	await expect(target).toHaveAttribute("data-drop-active", "true");
}

test.describe("Accessibility Audit", () => {
	test.describe("Login Page", () => {
		test("should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goto("/login");

			// Wait for stable content — admin pages need Astro compilation on first hit
			await expect(admin.page.locator("h1")).toContainText("Sign in", { timeout: 15000 });

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
		});
	});

	test.describe("Authenticated Pages", () => {
		test.beforeEach(async ({ admin }) => {
			await admin.devBypassAuth();
		});

		test("dashboard should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goToDashboard();
			await admin.waitForLoading();
			await expect(admin.page).toHaveURL(ADMIN_ROOT_URL);

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
		});

		test("dashboard card headings and metric values share an inset", async ({ admin }) => {
			await admin.goToDashboard();
			await admin.waitForLoading();

			const metricCards = admin.page.getByTestId("dashboard-metric");
			await expect.poll(() => metricCards.count()).toBeGreaterThanOrEqual(3);

			const layout = await admin.page.locator("main").evaluate((main) => {
				const textStart = (element: Element) => {
					const textNode = [...element.childNodes].find(
						(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
					);
					if (!textNode) throw new Error("Dashboard card text is missing");
					const range = document.createRange();
					range.selectNodeContents(textNode);
					const rect = range.getBoundingClientRect();
					return getComputedStyle(element).direction === "rtl" ? rect.right : rect.left;
				};
				const cardStart = (card: Element) => {
					const rect = card.getBoundingClientRect();
					return getComputedStyle(card).direction === "rtl" ? rect.right : rect.left;
				};
				const contentHeading = [...main.querySelectorAll("h2")].find(
					(heading) => heading.textContent?.trim() === "Content",
				);
				const contentCard = contentHeading?.parentElement?.parentElement;
				if (!contentHeading || !contentCard) throw new Error("Content card heading is missing");
				const headingInset = Math.abs(textStart(contentHeading) - cardStart(contentCard));

				const metrics = Array.from(
					main.querySelectorAll('[data-testid="dashboard-metric"]'),
					(card) => {
						const heading = card.querySelector("h2");
						const value = card.querySelector('[data-testid="dashboard-metric-value"]');
						if (!heading || !value) throw new Error("Metric label or value is missing");

						return {
							headingInset: Math.abs(textStart(heading) - cardStart(card)),
							labelValueGap: Math.abs(textStart(heading) - textStart(value)),
						};
					},
				);

				return { headingInset, metrics };
			});

			for (const metric of layout.metrics) {
				expect(metric.headingInset).toBeCloseTo(layout.headingInset, 1);
				expect(metric.labelValueGap).toBeLessThanOrEqual(0.5);
			}
		});

		test("dashboard headings keep the font's default tracking across scripts", async ({
			admin,
		}) => {
			await admin.goToDashboard();
			await admin.waitForLoading();
			await expect(admin.page.getByTestId("dashboard-metric-value").first()).toBeVisible();

			const trackingByLocale = await admin.page.locator("main").evaluate((main) => {
				const title = main.querySelector("h1");
				const metricValues = main.querySelectorAll('[data-testid="dashboard-metric-value"]');
				if (!title || metricValues.length === 0) throw new Error("Dashboard typography is missing");

				const root = document.documentElement;
				const originalLang = root.lang;
				const locales = ["en", "ja", "zh-CN"];

				try {
					return locales.map((locale) => {
						root.lang = locale;
						return {
							locale,
							title: getComputedStyle(title).letterSpacing,
							metrics: Array.from(metricValues, (value) => getComputedStyle(value).letterSpacing),
						};
					});
				} finally {
					root.lang = originalLang;
				}
			});

			for (const tracking of trackingByLocale) {
				expect(tracking.title, tracking.locale).toBe("normal");
				expect(tracking.metrics, tracking.locale).toEqual(tracking.metrics.map(() => "normal"));
			}
		});

		test("content list should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goToContent("posts");
			await admin.waitForLoading();
			await expect(admin.page).toHaveURL(CONTENT_POSTS_URL);

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
		});

		test("content editor should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();
			await expect(admin.page).toHaveURL(CONTENT_POSTS_NEW_URL);

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.exclude(".ProseMirror") // Rich text editor has complex a11y needs
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
		});

		test("media library should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goToMedia();
			await admin.waitForLoading();
			await expect(admin.page).toHaveURL(MEDIA_URL);

			const analyze = () =>
				new AxeBuilder({ page: admin.page })
					.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
					.disableRules(KNOWN_A11Y_EXCLUSIONS)
					.analyze();
			expect((await analyze()).violations).toEqual([]);

			const folderName = `Accessibility ${Date.now()}`;
			await admin.page.getByRole("button", { name: "Add new folder" }).click();
			const folderDialog = admin.page.getByRole("dialog", { name: "Add new folder" });
			expect((await analyze()).violations).toEqual([]);
			await folderDialog.getByLabel("Name").fill(folderName);
			await folderDialog.getByRole("button", { name: "Create" }).click();

			await admin.page.getByRole("button", { name: `Edit folder ${folderName}` }).click();
			expect((await analyze()).violations).toEqual([]);
			const editDialog = admin.page.getByRole("dialog", { name: "Edit folder" });
			await editDialog.getByRole("button", { name: "Delete folder" }).click();
			expect((await analyze()).violations).toEqual([]);
			await admin.page.getByRole("button", { name: "Cancel" }).last().click();
			await editDialog.getByRole("button", { name: "Cancel" }).click();

			await admin.page.getByRole("link", { name: `Open folder ${folderName}` }).click();
			expect((await analyze()).violations).toEqual([]);
			await admin.page.getByRole("button", { name: "Back to Main library" }).first().click();

			await admin.page.locator("[data-media-grid] button").first().click();
			const mediaDetails = admin.page.getByRole("dialog", { name: "Media Details" });
			await mediaDetails.getByRole("combobox", { name: "Location" }).click();
			expect((await analyze()).violations).toEqual([]);
			await admin.page.keyboard.press("Escape");
			await mediaDetails.getByRole("button", { name: "Close" }).click();

			await admin.page.getByRole("button", { name: `Edit folder ${folderName}` }).click();
			await editDialog.getByRole("button", { name: "Delete folder" }).click();
			await admin.page
				.getByRole("dialog", { name: `Delete “${folderName}”?` })
				.getByRole("button", { name: "Delete folder" })
				.click();
		});

		test("media list folder states should have no WCAG 2.x AA violations", async ({ admin }) => {
			test.setTimeout(60_000);
			const page = admin.page;
			const folderPattern = "**/_emdash/api/media/folders?**";
			let releaseFolders: () => void = () => {};
			const folderGate = new Promise<void>((resolve) => {
				releaseFolders = resolve;
			});
			await page.route(folderPattern, async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				await folderGate;
				await route.continue();
			});

			await admin.goToMedia();
			await expect(page.getByRole("heading", { name: "Media Library" })).toBeVisible();
			await page.getByRole("tab", { name: "List view" }).click();
			const table = page.getByRole("table");
			await expect(table.getByText("Loading folders")).toBeVisible();
			const analyze = () =>
				new AxeBuilder({ page })
					.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
					.disableRules(KNOWN_A11Y_EXCLUSIONS)
					.analyze();
			expect((await analyze()).violations).toEqual([]);

			releaseFolders();
			await expect(table.getByText("Loading folders")).not.toBeVisible();
			await page.unroute(folderPattern);
			const folderName = `List accessibility ${Date.now()}`;
			await page.getByRole("button", { name: "Add new folder" }).click();
			const folderDialog = page.getByRole("dialog", { name: "Add new folder" });
			await folderDialog.getByLabel("Name").fill(folderName);
			await folderDialog.getByRole("button", { name: "Create" }).click();
			await expect(page.getByRole("link", { name: `Open folder ${folderName}` })).toBeVisible();
			expect((await analyze()).violations).toEqual([]);

			await page.route(folderPattern, async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				const url = new URL(route.request().url());
				if (url.searchParams.has("cursor")) {
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({
							success: false,
							error: { code: "TEST_ERROR", message: "Folder list failed" },
						}),
					});
					return;
				}
				const response = await route.fetch();
				const body = (await response.json()) as { data: { nextCursor?: string } };
				body.data.nextCursor = "forced-accessibility-page";
				await route.fulfill({ response, json: body });
			});
			await page.reload();
			const listTab = page.getByRole("tab", { name: "List view" });
			if ((await listTab.getAttribute("aria-selected")) !== "true") await listTab.click();
			await page.getByRole("button", { name: "Load more folders" }).click();
			await expect(table.getByRole("alert")).toHaveText("Folders could not be loaded.");
			await expect(table.getByRole("button", { name: "Retry" })).toBeVisible();
			expect((await analyze()).violations).toEqual([]);

			await page.unroute(folderPattern);
			await page.reload();
			await page.getByRole("button", { name: `Edit folder ${folderName}` }).click();
			const editDialog = page.getByRole("dialog", { name: "Edit folder" });
			await editDialog.getByRole("button", { name: "Delete folder" }).click();
			await page
				.getByRole("dialog", { name: `Delete “${folderName}”?` })
				.getByRole("button", { name: "Delete folder" })
				.click();
		});

		test("media drag target and failure feedback should have no WCAG 2.x AA violations", async ({
			admin,
		}) => {
			test.setTimeout(60_000);
			const page = admin.page;
			await page.setViewportSize({ width: 1512, height: 982 });
			const folderName = `Drag accessibility ${Date.now()}`;
			await admin.goToMedia();
			await admin.waitForLoading();
			await page.getByRole("button", { name: "Add new folder" }).click();
			const createDialog = page.getByRole("dialog", { name: "Add new folder" });
			await createDialog.getByLabel("Name").fill(folderName);
			await createDialog.getByRole("button", { name: "Create" }).click();
			await page.reload();
			await admin.waitForLoading();
			const source = page.locator("[data-media-grid] > [data-media-draggable]").first();
			const target = page.locator("[data-media-folder-card]").filter({ hasText: folderName });
			const analyze = () =>
				new AxeBuilder({ page })
					.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
					.disableRules(KNOWN_A11Y_EXCLUSIONS)
					.analyze();

			await beginPointerDrag(page, source, target);
			expect((await analyze()).violations).toEqual([]);
			await page.keyboard.press("Escape");
			await page.mouse.up();

			await page.route("**/_emdash/api/media/**", async (route) => {
				if (route.request().method() !== "PUT") return route.continue();
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({
						success: false,
						error: { code: "MOVE_FAILED", message: "Move failed" },
					}),
				});
			});
			await beginPointerDrag(page, source, target);
			await page.mouse.up();
			await expect(page.getByText("Couldn’t move file", { exact: true })).toBeVisible();
			await expect(page.getByText("Try again.", { exact: true })).toBeVisible();
			expect((await analyze()).violations).toEqual([]);
			await page.unroute("**/_emdash/api/media/**");

			await page.getByRole("button", { name: `Edit folder ${folderName}` }).click();
			const editDialog = page.getByRole("dialog", { name: "Edit folder" });
			await editDialog.getByRole("button", { name: "Delete folder" }).click();
			const confirmDelete = page.getByRole("dialog", { name: `Delete “${folderName}”?` });
			await confirmDelete.getByRole("button", { name: "Delete folder" }).click();
			await expect(page.getByRole("link", { name: `Open folder ${folderName}` })).toHaveCount(0);
		});

		test("users page should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goto("/users");
			await admin.waitForShell();
			await admin.waitForLoading();
			await expect(admin.page).toHaveURL(USERS_URL);

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
		});

		test("settings page should have no WCAG 2.x AA violations", async ({ admin }) => {
			await admin.goToSettings();
			await admin.waitForLoading();
			await expect(admin.page).toHaveURL(SETTINGS_URL);

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
		});

		test("page descriptions meet regular-text contrast in the classic light theme", async ({
			admin,
			page,
		}) => {
			await page.emulateMedia({ colorScheme: "light" });
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			const description = page.getByText(
				"Manage installed plugins. Enable or disable plugins to control their functionality.",
				{ exact: true },
			);
			await expect(description).toBeVisible();

			const contrast = await description.evaluate((element) => {
				const canvas = document.createElement("canvas");
				canvas.width = 1;
				canvas.height = 1;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Canvas context unavailable");

				const toRgb = (color: string) => {
					context.clearRect(0, 0, 1, 1);
					context.fillStyle = color;
					context.fillRect(0, 0, 1, 1);
					return context.getImageData(0, 0, 1, 1).data;
				};
				const luminance = (rgb: Uint8ClampedArray) => {
					const toLinear = (channel: number) => {
						const value = channel / 255;
						return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
					};
					const red = toLinear(rgb[0] ?? 0);
					const green = toLinear(rgb[1] ?? 0);
					const blue = toLinear(rgb[2] ?? 0);
					return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
				};

				const foreground = luminance(toRgb(getComputedStyle(element).color));
				const background = luminance(toRgb(getComputedStyle(document.body).backgroundColor));
				return (
					(Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
				);
			});

			expect(contrast).toBeGreaterThanOrEqual(4.5);
		});

		test("content list should be keyboard navigable", async ({ admin }) => {
			await admin.goToContent("posts");
			await admin.waitForLoading();

			// Tab through key interactive elements
			await admin.page.keyboard.press("Tab");

			const focusedElements: string[] = [];
			for (let i = 0; i < 10; i++) {
				const focused = await admin.page.evaluate(() => document.activeElement?.tagName || "");
				focusedElements.push(focused);
				await admin.page.keyboard.press("Tab");
			}

			// Should have found interactive elements (buttons, links)
			expect(focusedElements.some((el) => el === "BUTTON" || el === "A")).toBe(true);
		});
	});
});
