/**
 * Accessibility E2E Tests
 *
 * Automated WCAG 2.1 AA audit using axe-core.
 * Tests for critical and high-priority accessibility issues across admin pages.
 */

import AxeBuilder from "@axe-core/playwright";

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

			const results = await new AxeBuilder({ page: admin.page })
				.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
				.disableRules(KNOWN_A11Y_EXCLUSIONS)
				.analyze();

			expect(results.violations).toEqual([]);
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
