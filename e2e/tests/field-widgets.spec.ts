/**
 * Field Widget E2E Tests (Playwright)
 *
 * Tests plugin field widgets in the admin UI:
 * - Color picker widget renders for fields with widget: "color:picker"
 * - Widget is interactive (color input, hex input, presets)
 * - Content saves and loads with widget field values
 * - Widget falls back to default renderer when plugin is not active
 * - Manifest includes widget metadata
 *
 * The e2e fixture has the color plugin configured with a "theme_color"
 * field (type: string, widget: "color:picker") on the posts collection.
 */

import { test, expect } from "../fixtures";

// The edit route preserves the entry's locale as a `?locale=` search param
// (see #1242), so the URL may carry a query string after the ULID.
const CONTENT_EDIT_URL_PATTERN = /\/content\/posts\/[A-Z0-9]+(?:\?.*)?$/;

test.describe("Field Widgets", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Color Picker Widget Rendering", () => {
		test("renders color picker widget on new post form", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			// The color picker widget should be visible (has data-testid)
			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });

			// Should have a color input
			const colorInput = admin.page.locator('[data-testid="color-input"]');
			await expect(colorInput).toBeVisible();
			await expect(colorInput).toHaveAttribute("type", "color");

			// Should have a hex text input
			const hexInput = admin.page.locator('[data-testid="color-hex-input"]');
			await expect(hexInput).toBeVisible();

			// Should have a preview swatch
			const preview = admin.page.locator('[data-testid="color-preview"]');
			await expect(preview).toBeVisible();

			// Should have preset color buttons
			const presets = admin.page.locator('[data-testid="color-presets"]');
			await expect(presets).toBeVisible();
			const presetButtons = presets.locator("button");
			await expect(presetButtons).toHaveCount(10);
		});

		test("shows field label for color widget", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			// The label "Theme Color" should be visible
			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });
			await expect(widget.locator("label")).toContainText("Theme Color");
		});

		test("other fields render with default editors", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			// Title field should use standard input (not a widget)
			const titleInput = admin.page.locator("#field-title");
			await expect(titleInput).toBeVisible();
			// Should be a plain input, not a color picker widget
			await expect(admin.page.locator('[data-testid="color-picker-widget"]')).toHaveCount(1);
			await expect(
				titleInput.locator("..").locator('[data-testid="color-picker-widget"]'),
			).toHaveCount(0);
		});
	});

	test.describe("Color Picker Interaction", () => {
		test("can type a hex value", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			const hexInput = admin.page.locator('[data-testid="color-hex-input"]');
			await expect(hexInput).toBeVisible({ timeout: 10000 });
			await hexInput.fill("#ff6600");
			await expect(hexInput).toHaveValue("#ff6600");
		});

		test("clicking a preset updates the value", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });

			// Click the red preset (#ef4444)
			const redPreset = admin.page.locator('[data-testid="color-preset-ef4444"]');
			await expect(redPreset).toBeVisible();
			await redPreset.click();

			// Hex input should update
			const hexInput = admin.page.locator('[data-testid="color-hex-input"]');
			await expect(hexInput).toHaveValue("#ef4444");
		});

		test("clicking different presets changes the value", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });
			const hexInput = admin.page.locator('[data-testid="color-hex-input"]');

			// Click blue preset
			await admin.page.locator('[data-testid="color-preset-3b82f6"]').click();
			await expect(hexInput).toHaveValue("#3b82f6");

			// Click green preset
			await admin.page.locator('[data-testid="color-preset-22c55e"]').click();
			await expect(hexInput).toHaveValue("#22c55e");
		});
	});

	test.describe("Save and Load Widget Values", () => {
		test("saves content with color value and loads it back", async ({ admin }) => {
			// Create a post with a color
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			// Wait for widget to render
			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });

			// Fill title
			await admin.fillField("title", "Color Widget Test Post");

			// Set color via hex input
			const hexInput = admin.page.locator('[data-testid="color-hex-input"]');
			await hexInput.fill("#ff6600");

			// Save
			await admin.clickSave();
			await admin.waitForSaveComplete();

			// Should redirect to edit page
			await expect(admin.page).toHaveURL(CONTENT_EDIT_URL_PATTERN, {
				timeout: 10000,
			});

			// Reload the page to verify the value persisted
			await admin.page.reload();
			await admin.waitForLoading();

			// Wait for widget and check value
			await expect(widget).toBeVisible({ timeout: 10000 });
			const reloadedHex = admin.page.locator('[data-testid="color-hex-input"]');
			await expect(reloadedHex).toHaveValue("#ff6600");
		});

		test("saves content with preset color value", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });

			await admin.fillField("title", "Preset Color Post");

			// Click purple preset
			await admin.page.locator('[data-testid="color-preset-8b5cf6"]').click();

			await admin.clickSave();
			await admin.waitForSaveComplete();

			await expect(admin.page).toHaveURL(CONTENT_EDIT_URL_PATTERN, {
				timeout: 10000,
			});

			// Reload and verify
			await admin.page.reload();
			await admin.waitForLoading();
			await expect(widget).toBeVisible({ timeout: 10000 });
			await expect(admin.page.locator('[data-testid="color-hex-input"]')).toHaveValue("#8b5cf6");
		});

		test("saves content without color value", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			const widget = admin.page.locator('[data-testid="color-picker-widget"]');
			await expect(widget).toBeVisible({ timeout: 10000 });

			// Just set title, don't touch color
			await admin.fillField("title", "No Color Post");

			await admin.clickSave();
			await admin.waitForSaveComplete();

			// Should save successfully
			await expect(admin.page).toHaveURL(CONTENT_EDIT_URL_PATTERN, {
				timeout: 10000,
			});
		});
	});

	test.describe("Manifest API", () => {
		test("manifest includes widget property on theme_color field", async ({ page }) => {
			const res = await page.request.get("/_emdash/api/manifest", {
				headers: { "X-EmDash-Request": "1" },
			});
			expect(res.ok()).toBe(true);
			const body = await res.json();
			const manifest = body.data;

			// Check field has widget
			const postFields = manifest.collections.posts.fields;
			expect(postFields.theme_color).toBeDefined();
			expect(postFields.theme_color.widget).toBe("color:picker");
			expect(postFields.theme_color.kind).toBe("string");

			// Other fields should not have widget
			expect(postFields.title.widget).toBeUndefined();
		});

		test("manifest includes color plugin with fieldWidgets", async ({ page }) => {
			const res = await page.request.get("/_emdash/api/manifest", {
				headers: { "X-EmDash-Request": "1" },
			});
			const body = await res.json();
			const manifest = body.data;

			// Check plugin manifest
			expect(manifest.plugins.color).toBeDefined();
			expect(manifest.plugins.color.enabled).toBe(true);
			expect(manifest.plugins.color.fieldWidgets).toBeDefined();
			expect(manifest.plugins.color.fieldWidgets).toHaveLength(1);
			expect(manifest.plugins.color.fieldWidgets[0].name).toBe("picker");
			expect(manifest.plugins.color.fieldWidgets[0].label).toBe("Color Picker");
			expect(manifest.plugins.color.fieldWidgets[0].fieldTypes).toEqual(["string"]);
		});
	});
});
