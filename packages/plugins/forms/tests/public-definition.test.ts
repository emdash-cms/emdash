import { describe, expect, it, vi } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";
import {
	loadPublicFormDefinition,
	parsePublicFormDefinitionPayload,
	parsePublicFormDefinitionResponse,
} from "../src/public-definition.js";

const activeForm: PublicFormDefinition = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{
					id: "email",
					type: "email",
					label: "Email",
					name: "email",
					required: true,
					width: "full",
				},
			],
		},
	],
	settings: {
		spamProtection: "none",
		submitLabel: "Send",
	},
	status: "active",
	_turnstileSiteKey: null,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("parsePublicFormDefinitionResponse", () => {
	it("unwraps public plugin route responses from the standard API envelope", async () => {
		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ data: activeForm })),
		).resolves.toEqual(activeForm);
	});

	it("returns null for missing form data", async () => {
		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ data: undefined })),
		).resolves.toBeNull();
	});

	it("returns null for inactive forms and failed responses", async () => {
		await expect(
			parsePublicFormDefinitionResponse(
				jsonResponse({ data: { ...activeForm, status: "paused" } }),
			),
		).resolves.toBeNull();

		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ error: { message: "Not found" } }, 404)),
		).resolves.toBeNull();
	});

	it("does not recursively unwrap nested response envelopes", async () => {
		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ data: { data: activeForm } })),
		).resolves.toBeNull();
		await expect(
			parsePublicFormDefinitionResponse(
				jsonResponse({ data: { success: true, data: activeForm } }),
			),
		).resolves.toBeNull();
	});
});

describe("parsePublicFormDefinitionPayload", () => {
	it("unwraps successful handler results with an active form", () => {
		expect(parsePublicFormDefinitionPayload({ success: true, data: activeForm })).toEqual(
			activeForm,
		);
	});

	it("returns null for missing or inactive handler result data", () => {
		expect(parsePublicFormDefinitionPayload({ success: true, data: undefined })).toBeNull();
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: { ...activeForm, status: "paused" },
			}),
		).toBeNull();
	});

	it("returns null for failed handler results", () => {
		expect(
			parsePublicFormDefinitionPayload({
				success: false,
				error: { code: "NOT_FOUND", message: "Form not found" },
			}),
		).toBeNull();
	});

	it("does not recursively unwrap nested handler result data", () => {
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: { data: activeForm },
			}),
		).toBeNull();
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: { success: true, data: activeForm },
			}),
		).toBeNull();
	});

	it("returns null for malformed active form data", () => {
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: { status: "active" },
			}),
		).toBeNull();
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: { ...activeForm, pages: undefined },
			}),
		).toBeNull();
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: { ...activeForm, settings: undefined },
			}),
		).toBeNull();
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: {
					...activeForm,
					pages: [{ fields: [{ ...activeForm.pages[0]!.fields[0]!, type: "unknown" }] }],
				},
			}),
		).toBeNull();
		expect(
			parsePublicFormDefinitionPayload({
				success: true,
				data: {
					...activeForm,
					pages: [{ fields: [{ ...activeForm.pages[0]!.fields[0]!, options: {} }] }],
				},
			}),
		).toBeNull();
	});
});

describe("loadPublicFormDefinition", () => {
	it("loads active forms through the internal public plugin route handler", async () => {
		const handlePublicPluginApiRoute = vi.fn(async () => ({ success: true, data: activeForm }));
		const fetch = vi.fn(async () => jsonResponse({ data: activeForm }));

		await expect(
			loadPublicFormDefinition({
				formId: "contact",
				baseUrl: new URL("https://example.com/contact"),
				handlePublicPluginApiRoute,
				fetch,
			}),
		).resolves.toEqual(activeForm);

		expect(handlePublicPluginApiRoute).toHaveBeenCalledWith(
			"emdash-forms",
			"POST",
			"/definition",
			expect.any(Request),
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("treats internal missing or inactive results as definitive", async () => {
		const handlePublicPluginApiRoute = vi.fn(async () => ({
			success: false,
			error: { code: "NOT_FOUND", message: "Form not found" },
		}));
		const fetch = vi.fn(async () => jsonResponse({ data: activeForm }));

		await expect(
			loadPublicFormDefinition({
				formId: "missing",
				baseUrl: new URL("https://example.com/contact"),
				handlePublicPluginApiRoute,
				fetch,
			}),
		).resolves.toBeNull();

		expect(fetch).not.toHaveBeenCalled();
	});

	it("treats malformed internal results as definitive", async () => {
		const handlePublicPluginApiRoute = vi.fn(async () => ({
			success: true,
			data: { status: "active" },
		}));
		const fetch = vi.fn(async () => jsonResponse({ data: activeForm }));

		await expect(
			loadPublicFormDefinition({
				formId: "contact",
				baseUrl: new URL("https://example.com/contact"),
				handlePublicPluginApiRoute,
				fetch,
			}),
		).resolves.toBeNull();

		expect(fetch).not.toHaveBeenCalled();
	});

	it("falls back to fetching the public definition route when no handler is available", async () => {
		const fetch = vi.fn(async () => jsonResponse({ data: activeForm }));

		await expect(
			loadPublicFormDefinition({
				formId: "contact",
				baseUrl: new URL("https://example.com/contact"),
				fetch,
			}),
		).resolves.toEqual(activeForm);

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not fall back to fetching when the internal handler throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handlePublicPluginApiRoute = vi.fn(async () => {
			throw new Error("dispatcher unavailable");
		});
		const fetch = vi.fn(async () => jsonResponse({ data: activeForm }));

		try {
			await expect(
				loadPublicFormDefinition({
					formId: "contact",
					baseUrl: new URL("https://example.com/contact"),
					handlePublicPluginApiRoute,
					fetch,
				}),
			).resolves.toBeNull();

			expect(fetch).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(
				"[emdash-forms] public definition dispatcher failed:",
				expect.any(Error),
			);
		} finally {
			warn.mockRestore();
		}
	});
});
