/**
 * Admin Page Object for E2E tests
 *
 * Provides a clean API for interacting with the EmDash admin UI.
 */

import { type Page, expect } from "@playwright/test";

// Regex patterns
const ADMIN_URL_PATTERN = /\/_emdash\/admin/;
const ADMIN_DASHBOARD_PATTERN = /\/_emdash\/admin\/?$/;
const CONTENT_ID_EXTRACTION_PATTERN = /\/content\/[^/]+\/([^/]+)$/;
const MENU_URL_PATTERN = /\/_emdash\/admin\/menus\//;
const SETUP_PAGE_PATTERN = /\/_emdash\/admin\/setup/;

export class AdminPage {
	readonly page: Page;
	readonly baseUrl = "/_emdash/admin";

	constructor(page: Page) {
		this.page = page;
	}

	/**
	 * Authenticate using dev bypass (creates session)
	 * Call this before accessing protected pages.
	 *
	 * Navigates through the bypass URLs which sets cookies in the browser context.
	 */
	async devBypassAuth(): Promise<void> {
		// Navigate to setup bypass - this sets up the site AND creates a session
		// The redirect param sends us to auth bypass to ensure cookies are set
		await this.page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/");

		// Wait for the redirect to complete and admin shell to appear
		await this.page.waitForURL(ADMIN_URL_PATTERN, { timeout: 30000 });

		// Wait for page to be usable. Race networkidle (Vite dep re-optimization) against
		// the hydration signal so HMR websocket can't stall us indefinitely.
		await Promise.race([
			this.page.waitForLoadState("networkidle").catch(() => {}),
			this.waitForHydration().catch(() => {}),
		]);

		// Remove any vite error overlay that appeared during SSR
		await this.dismissViteOverlay();

		// If we got a server error, reload — the error is usually transient
		const hasErrorOverlay = await this.page.locator("vite-error-overlay").count();
		if (hasErrorOverlay > 0) {
			await this.dismissViteOverlay();
			await this.page.reload();
		}

		// Wait for the shell to fully hydrate
		await this.waitForShell();
	}

	/**
	 * Navigate to an admin page
	 */
	async goto(path = "/"): Promise<void> {
		const url = path === "/" ? this.baseUrl : `${this.baseUrl}${path}`;
		await this.page.goto(url);
	}

	/**
	 * Wait for React hydration to complete.
	 * Astro removes the `ssr` attribute from `<astro-island>` after hydration.
	 */
	async waitForHydration(): Promise<void> {
		await this.page.waitForSelector("astro-island:not([ssr])", { timeout: 15000 });
	}

	/**
	 * Wait for the admin shell to be ready (hydrated and interactive)
	 */
	async waitForShell(): Promise<void> {
		// Dismiss vite error overlay if present (from previous request errors)
		await this.dismissViteOverlay();

		// Wait for sidebar to appear (indicates manifest loaded and React hydrated)
		const maxRetries = 3;
		let lastError: unknown;
		for (let i = 0; i < maxRetries; i++) {
			try {
				// Wait for both sidebar and hydration signal
				await this.page.waitForSelector('aside[aria-label="Admin navigation"]', {
					timeout: 15000,
				});
				await this.waitForHydration();
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				if (i < maxRetries - 1) {
					// Server may be restarting (Vite re-optimization). Retry with reload.
					// Wrap in try/catch since reload itself can fail if server is mid-restart.
					try {
						await this.dismissViteOverlay();
						await this.page.reload({ waitUntil: "load" });
						await this.dismissViteOverlay();
					} catch {
						// Server still down — wait for it to come back before next retry
						await this.page.waitForLoadState("load").catch(() => {});
					}
				}
			}
		}
		if (lastError) {
			throw lastError;
		}

		// Dismiss the onboarding "Welcome" modal if it appears
		await this.dismissOnboardingModal();
	}

	/**
	 * Dismiss the onboarding "Welcome" modal if it appears
	 */
	async dismissOnboardingModal(): Promise<void> {
		const getStartedBtn = this.page.locator('button:has-text("Get Started")');
		if (await getStartedBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
			await getStartedBtn.click();
			await this.page
				.locator("[data-base-ui-inert]")
				.waitFor({ state: "hidden", timeout: 5000 })
				.catch(() => {});
		}
	}

	/**
	 * Dismiss vite-error-overlay if present
	 */
	async dismissViteOverlay(): Promise<void> {
		// Remove vite-error-overlay from DOM if present — it has aria-hidden="true"
		// so Playwright's isVisible() won't detect it, but it still blocks pointer events
		await this.page
			.evaluate(() => {
				document.querySelectorAll("vite-error-overlay").forEach((el) => el.remove());
			})
			.catch(() => {});
	}

	/**
	 * Wait for loading states to complete
	 */
	async waitForLoading(): Promise<void> {
		// Wait for loading text and spinners to disappear
		await this.page
			.locator("text=Loading")
			.waitFor({ state: "hidden", timeout: 15000 })
			.catch(() => {});
		await this.page
			.locator(".animate-spin")
			.waitFor({ state: "hidden", timeout: 10000 })
			.catch(() => {});
	}

	// ============================================
	// Navigation
	// ============================================

	/**
	 * Navigate to dashboard
	 */
	async goToDashboard(): Promise<void> {
		await this.goto("/");
		await this.waitForShell();
	}

	/**
	 * Navigate to content list for a collection
	 */
	async goToContent(collection: string): Promise<void> {
		await this.goto(`/content/${collection}`);
		await this.waitForShell();
	}

	/**
	 * Navigate to create new content
	 */
	async goToNewContent(collection: string): Promise<void> {
		await this.goto(`/content/${collection}/new`);
		await this.waitForShell();
	}

	/**
	 * Navigate to edit content
	 */
	async goToEditContent(collection: string, id: string): Promise<void> {
		await this.goto(`/content/${collection}/${id}`);
		await this.waitForShell();
	}

	/**
	 * Navigate to media library
	 */
	async goToMedia(): Promise<void> {
		await this.goto("/media");
		await this.waitForShell();
	}

	/**
	 * Navigate to menus list
	 */
	async goToMenus(): Promise<void> {
		await this.goto("/menus");
		await this.waitForShell();
	}

	/**
	 * Navigate to edit a specific menu
	 */
	async goToMenuEditor(name: string): Promise<void> {
		await this.goto(`/menus/${name}`);
		await this.waitForShell();
	}

	/**
	 * Navigate to settings
	 */
	async goToSettings(): Promise<void> {
		await this.goto("/settings");
		await this.waitForShell();
	}

	/**
	 * Navigate to setup wizard
	 */
	async goToSetup(): Promise<void> {
		await this.goto("/setup");
	}

	// ============================================
	// Setup Wizard Actions
	// ============================================

	/**
	 * Complete the setup wizard
	 */
	async completeSetup(options: {
		title: string;
		tagline?: string;
		includeContent?: boolean;
	}): Promise<void> {
		// Fill title
		await this.page.fill("#title", options.title);

		// Fill tagline if provided
		if (options.tagline) {
			await this.page.fill("#tagline", options.tagline);
		}

		// Handle content checkbox if it exists
		if (options.includeContent !== undefined) {
			const checkbox = this.page.locator("#includeContent");
			if (await checkbox.isVisible()) {
				const isChecked = await checkbox.isChecked();
				if (options.includeContent && !isChecked) {
					await checkbox.click();
				} else if (!options.includeContent && isChecked) {
					await checkbox.click();
				}
			}
		}

		// Submit
		await this.page.click('button[type="submit"]');
	}

	// ============================================
	// Content CRUD Actions
	// ============================================

	/**
	 * Create new content with field data
	 */
	async createContent(collection: string, data: Record<string, string>): Promise<string> {
		await this.goToNewContent(collection);

		// Fill in form fields
		for (const [field, value] of Object.entries(data)) {
			await this.fillField(field, value);
		}

		// Save
		await this.clickSave();
		await this.waitForSaveComplete();

		// Return the new content ID from URL
		const url = this.page.url();
		const match = url.match(CONTENT_ID_EXTRACTION_PATTERN);
		return match?.[1] || "";
	}

	/**
	 * Update content field
	 */
	async updateField(field: string, value: string): Promise<void> {
		await this.fillField(field, value);
	}

	/**
	 * Fill a form field by slug (uses #field-{slug} convention)
	 */
	async fillField(slug: string, value: string): Promise<void> {
		const input = this.page.locator(`#field-${slug}`);
		await input.fill(value);
	}

	/**
	 * Click the save button
	 */
	async clickSave(): Promise<void> {
		await this.page.locator('button:has-text("Save")').click();
	}

	/**
	 * Wait for save to complete
	 */
	async waitForSaveComplete(): Promise<void> {
		// Wait for the save button to show "Saved" or stop showing "Saving..."
		await this.page
			.getByRole("button", { name: "Saved" })
			.waitFor({ timeout: 10000 })
			.catch(() => {});
		await this.waitForLoading();
	}

	/**
	 * Delete content item by clicking delete button
	 */
	async deleteContentItem(title: string): Promise<void> {
		// Find the row with this title and click delete
		const row = this.page.locator("tr", { hasText: title });
		await row.locator('button[aria-label*="Delete"]').click();

		// Handle confirmation
		this.page.once("dialog", (dialog) => dialog.accept());
	}

	// ============================================
	// Media Library Actions
	// ============================================

	/**
	 * Upload a file to media library
	 */
	async uploadMedia(filePath: string): Promise<void> {
		// Click upload button to trigger file input
		const fileInput = this.page.locator('input[type="file"]');
		await fileInput.setInputFiles(filePath);

		// Wait for upload to complete
		await this.page.waitForResponse(
			(response) => response.url().includes("/api/media") && response.status() === 200,
		);
		await this.waitForLoading();
	}

	/**
	 * Get count of media items
	 */
	async getMediaCount(): Promise<number> {
		const items = this.page.locator('[class*="grid"] > div');
		return items.count();
	}

	/**
	 * Delete a media item by filename
	 */
	async deleteMedia(filename: string): Promise<void> {
		// Hover over the item to show delete button
		const item = this.page.locator(`[alt="${filename}"]`).first();
		await item.hover();

		// Click delete
		const deleteBtn = this.page.locator('button:has-text("Delete")').first();
		await deleteBtn.click();

		// Handle confirmation
		this.page.once("dialog", (dialog) => dialog.accept());
	}

	// ============================================
	// Menu Actions
	// ============================================

	/**
	 * Create a new menu
	 */
	async createMenu(name: string, label: string): Promise<void> {
		// Click create menu button
		await this.page.getByRole("button", { name: "Create Menu" }).first().click();

		// Fill form
		await this.page.getByLabel("Name").fill(name);
		await this.page.getByLabel("Label").fill(label);

		// Submit and wait for navigation
		await Promise.all([
			this.page.waitForURL(MENU_URL_PATTERN, {
				timeout: 15000,
			}),
			this.page.getByRole("button", { name: "Create" }).click(),
		]);
	}

	/**
	 * Add a custom link to current menu
	 */
	async addMenuLink(label: string, url: string): Promise<void> {
		// Click add link button
		await this.page.getByRole("button", { name: "Add Custom Link" }).first().click();

		// Wait for dialog to appear
		await this.page.waitForSelector('[role="dialog"]', { state: "visible", timeout: 5000 });

		// Fill form (scope to dialog to avoid ambiguity)
		const dialog = this.page.locator('[role="dialog"]');
		await dialog.getByLabel("Label").fill(label);
		await dialog.getByLabel("URL").fill(url);

		// Submit
		await dialog.getByRole("button", { name: "Add" }).click();

		// Wait for dialog to close
		await this.page.waitForSelector('[role="dialog"]', { state: "hidden" });
	}

	/**
	 * Delete a menu
	 */
	async deleteMenu(name: string): Promise<void> {
		// Find menu row and click delete
		const menuRow = this.page.locator(`a[href*="/menus/${name}"]`).first();
		const row = menuRow.locator("..");
		await row.locator('button:has(svg[class*="Trash"])').click();

		// Confirm deletion
		await this.page.click('button:has-text("Delete"):not([disabled])');
	}

	/**
	 * Get list of menu items
	 */
	async getMenuItems(): Promise<string[]> {
		const items = this.page.locator(".border.rounded-lg.p-4 .font-medium");
		const texts = await items.allTextContents();
		return texts;
	}

	// ============================================
	// i18n / Translation Actions
	// ============================================

	/**
	 * Get the locale column values from the content list table.
	 * Returns empty array if locale column is not shown.
	 */
	async getLocaleColumnValues(): Promise<string[]> {
		const cells = this.page.locator("table tbody tr td span.rounded.bg-kumo-tint");
		return cells.allTextContents();
	}

	/**
	 * Get the locale badge shown in the content editor header.
	 * Returns null if no locale badge is visible.
	 */
	async getEditorLocaleBadge(): Promise<string | null> {
		const badge = this.page
			.locator("span.rounded.bg-kumo-tint.text-xs.font-semibold.uppercase")
			.first();
		if (await badge.isVisible({ timeout: 3000 }).catch(() => false)) {
			return badge.textContent();
		}
		return null;
	}

	/**
	 * Get available translation locales from the translations sidebar.
	 * Returns an array of locale codes shown in the sidebar.
	 */
	async getTranslationSidebarLocales(): Promise<string[]> {
		const sidebar = this.page.locator("div:has(> h3:text-is('Translations'))");
		const localeCodes = sidebar.locator("span.text-xs.font-semibold.uppercase");
		return localeCodes.allTextContents();
	}

	/**
	 * Click the "Translate" button for a specific locale in the translations sidebar.
	 */
	async clickTranslate(locale: string): Promise<void> {
		// Find the translation row for this locale (the div containing the locale code)
		const sidebar = this.page.locator("div:has(> h3:text-is('Translations'))");
		const localeRow = sidebar.locator(`div:has(> div > span.uppercase:text-is("${locale}"))`);
		await localeRow.getByRole("button", { name: "Translate" }).click();
	}

	/**
	 * Click "Edit" link for an existing translation in the sidebar.
	 */
	async clickEditTranslation(locale: string): Promise<void> {
		const sidebar = this.page.locator("div:has(> h3:text-is('Translations'))");
		const localeRow = sidebar.locator(`div:has(> div > span.uppercase:text-is("${locale}"))`);
		await localeRow.getByRole("button", { name: "Edit" }).click();
	}

	/**
	 * Check if a "Translate" button exists for a locale in the translations sidebar.
	 */
	async hasTranslateButton(locale: string): Promise<boolean> {
		const sidebar = this.page.locator("div:has(> h3:text-is('Translations'))");
		const localeRow = sidebar.locator(`div:has(> div > span.uppercase:text-is("${locale}"))`);
		return localeRow
			.getByRole("button", { name: "Translate" })
			.isVisible({ timeout: 3000 })
			.catch(() => false);
	}

	/**
	 * Check if an "Edit" link exists for a locale in the translations sidebar.
	 */
	async hasEditTranslationLink(locale: string): Promise<boolean> {
		const sidebar = this.page.locator("div:has(> h3:text-is('Translations'))");
		const localeRow = sidebar.locator(`div:has(> div > span.uppercase:text-is("${locale}"))`);
		return localeRow
			.getByRole("button", { name: "Edit" })
			.isVisible({ timeout: 3000 })
			.catch(() => false);
	}

	/**
	 * Get the locale switcher select value from the content list.
	 */
	async getLocaleFilterValue(): Promise<string | null> {
		const select = this.page.locator("select").first();
		if (await select.isVisible({ timeout: 3000 }).catch(() => false)) {
			return select.inputValue();
		}
		return null;
	}

	/**
	 * Change the locale filter in the content list.
	 */
	async setLocaleFilter(locale: string): Promise<void> {
		await this.page.locator("select").first().selectOption(locale);
		await this.waitForLoading();
	}

	// ============================================
	// Assertions
	// ============================================

	/**
	 * Assert we're on the dashboard
	 */
	async expectDashboard(): Promise<void> {
		await expect(this.page).toHaveURL(ADMIN_DASHBOARD_PATTERN);
	}

	/**
	 * Assert we're on the setup page
	 */
	async expectSetupPage(): Promise<void> {
		await expect(this.page).toHaveURL(SETUP_PAGE_PATTERN);
	}

	/**
	 * Assert a toast message appears
	 */
	async expectToast(text: string): Promise<void> {
		await expect(this.page.locator('[role="status"]', { hasText: text })).toBeVisible();
	}

	/**
	 * Assert content exists in list
	 */
	async expectContentInList(title: string): Promise<void> {
		await expect(this.page.locator("td", { hasText: title })).toBeVisible();
	}

	/**
	 * Assert content does not exist in list
	 */
	async expectContentNotInList(title: string): Promise<void> {
		await expect(this.page.locator("td", { hasText: title })).not.toBeVisible();
	}

	/**
	 * Assert menu exists in list
	 */
	async expectMenuInList(label: string): Promise<void> {
		await expect(this.page.locator("h3", { hasText: label })).toBeVisible();
	}

	/**
	 * Assert page title
	 */
	async expectPageTitle(title: string): Promise<void> {
		await expect(this.page.locator("h1").first()).toContainText(title);
	}
}
