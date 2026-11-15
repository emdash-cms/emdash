import { describe, expect, it } from "vitest";

import {
	createPlugin,
	DEFAULT_EMAIL_EDITOR_CONFIG,
	DEFAULT_EMAIL_BLOCKS,
	EMAIL_SAFE_FONTS,
	applyEmailSafeFont,
	emailTemplatesPlugin,
} from "../src/index.js";

describe("email templates plugin", () => {
	it("is disabled by default", () => {
		const descriptor = emailTemplatesPlugin();

		expect(descriptor.options).toEqual({
			enabled: false,
			campaignsEnabled: false,
			storagePrefix: "email-templates",
		});
		expect(createPlugin().storage).toEqual({});
		expect(createPlugin().admin.pages).toBeUndefined();
	});

	it("declares storage and admin settings when enabled", () => {
		const plugin = createPlugin({
			enabled: true,
			campaignsEnabled: true,
			storagePrefix: "mail",
		});

		expect(plugin.storage.templates).toEqual({
			indexes: ["status", "createdAt", "updatedAt"],
			uniqueIndexes: ["slug"],
		});
		expect(plugin.admin.pages).toEqual([{ path: "/", label: "Email Templates", icon: "mail" }]);
		expect(plugin.admin.settingsSchema?.campaignsEnabled).toEqual({
			type: "boolean",
			label: "Enable email campaigns",
		});
		expect(Object.keys(plugin.admin.settingsSchema ?? {})).toEqual([
			"campaignsEnabled",
			"defaultSenderName",
			"supportEmail",
			"siteName",
			"websiteUrl",
			"facebookUrl",
			"instagramUrl",
			"xUrl",
			"githubUrl",
			"linkedinUrl",
			"youtubeUrl",
		]);
	});

	it("provides an email-safe visual editor configuration", () => {
		expect(DEFAULT_EMAIL_EDITOR_CONFIG.defaultLayout.type).toBe("section");
		expect(DEFAULT_EMAIL_BLOCKS.map((block) => block.type)).toEqual([
			"branding",
			"footer",
			"text",
			"heading",
			"image",
			"button",
			"divider",
			"spacer",
			"social",
			"html",
		]);
		expect(
			EMAIL_SAFE_FONTS.every((font) => /sans-serif|serif|monospace/.test(font.fontFamily)),
		).toBe(true);
	});

	it("adds a safe font stack to exported email HTML", () => {
		expect(applyEmailSafeFont("<html><body><p>Hello</p></body></html>")).toContain(
			"font-family: Arial, Helvetica, sans-serif;",
		);
		expect(applyEmailSafeFont('<body style="color: red;">')).toContain(
			"color: red; font-family: Arial, Helvetica, sans-serif;",
		);
	});
});
