import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { initForms } from "../src/client/index.js";
import type { PublicFormDefinition } from "../src/public-definition.js";

const definition: PublicFormDefinition = {
	name: "Contact",
	slug: "contact",
	pages: [{ fields: [] }],
	settings: { submitLabel: "Nachricht senden" },
	status: "active",
	_turnstileSiteKey: null,
};

vi.mock("emdash/plugin-utils", () => ({ getPublicPluginApiRouteHandler: () => undefined }));
vi.mock("../src/public-definition.js", () => ({
	loadPublicFormDefinition: () => Promise.resolve(definition),
}));

beforeAll(() => {
	const { window } = new JSDOM("", { url: "https://example.com" });
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", window.document);
	vi.stubGlobal("FormData", window.FormData);
	vi.stubGlobal("sessionStorage", window.sessionStorage);
});

afterAll(() => {
	window.close();
	vi.unstubAllGlobals();
});

describe("FormEmbed submit label", () => {
	for (const label of ["Nachricht senden", 'Senden & bestätigen "jetzt"', ""]) {
		test.each(["success", "validation error", "server error", "network error"])(
			`restores ${JSON.stringify(label || "Submit")} after %s, including repeated submissions`,
			async (outcome) => {
				definition.settings.submitLabel = label;
				const { default: FormEmbed } = await import("../src/astro/FormEmbed.astro");
				const container = await AstroContainer.create();
				document.body.innerHTML = await container.renderToString(FormEmbed, {
					props: { node: { formId: "contact" } },
				});
				const form = document.querySelector<HTMLFormElement>("[data-ec-form]")!;
				const button = form.querySelector<HTMLButtonElement>(".ec-form-submit")!;
				const expectedLabel = label || "Submit";
				expect(button.textContent?.trim()).toBe(expectedLabel);
				initForms();

				const fetchMock = vi.fn(async () => {
					if (outcome === "network error") throw new Error("Offline");
					return {
						json: async () => ({
							data:
								outcome === "success"
									? { success: true }
									: outcome === "validation error"
										? { errors: [{ field: "email", message: "Invalid email" }] }
										: { success: false },
						}),
					};
				});
				vi.stubGlobal("fetch", fetchMock);

				for (let attempt = 1; attempt <= 2; attempt++) {
					form.requestSubmit();
					expect(button.disabled).toBe(true);
					expect(button.textContent).toBe("Submitting...");
					await vi.waitFor(() => expect(button.disabled).toBe(false));
					expect(fetchMock).toHaveBeenCalledTimes(attempt);
					expect(button.textContent).toBe(expectedLabel);
				}
			},
		);
	}
});
