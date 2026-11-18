import type { Messages } from "@lingui/core";
import { describe, expect, it } from "vitest";

import { translateAdminShellLabels } from "../src/locales/server.js";

describe("admin shell localization", () => {
	it("translates the tab title and loading text with the site name", () => {
		const messages: Messages = {
			"adminShell.title": ["Administration de ", ["siteName"]],
			"adminShell.loading": ["Chargement de ", ["siteName"], "…"],
		};

		expect(translateAdminShellLabels(messages, "Mon site")).toEqual({
			title: "Administration de Mon site",
			loading: "Chargement de Mon site…",
		});
	});

	it("uses the default labels when no site name is configured", () => {
		const messages: Messages = {
			"adminShell.defaultTitle": ["Administration EmDash"],
			"adminShell.defaultLoading": ["Chargement d’EmDash…"],
		};

		expect(translateAdminShellLabels(messages)).toEqual({
			title: "Administration EmDash",
			loading: "Chargement d’EmDash…",
		});
	});

	it("falls back to English when the catalog has no translation yet", () => {
		expect(translateAdminShellLabels({}, "Mon site")).toEqual({
			title: "Mon site Admin",
			loading: "Loading Mon site...",
		});
	});

	it("keeps dollar signs in the site name literal", () => {
		expect(translateAdminShellLabels({}, "Cash $& Co").title).toBe("Cash $& Co Admin");
	});
});
