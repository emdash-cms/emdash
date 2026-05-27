import { parseApiResponse, type PublicPluginApiRouteHandler } from "emdash/plugin-utils";

import type { FormDefinition } from "./types.js";

export interface PublicFormDefinition {
	name: string;
	slug: string;
	pages: FormDefinition["pages"];
	settings: Pick<
		FormDefinition["settings"],
		"spamProtection" | "submitLabel" | "nextLabel" | "prevLabel"
	>;
	status: FormDefinition["status"];
	_turnstileSiteKey?: string | null;
}

interface LoadPublicFormDefinitionOptions {
	formId: string;
	baseUrl: URL;
	handlePublicPluginApiRoute?: PublicPluginApiRouteHandler;
	fetch?: (input: Request) => Promise<Response>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalStringOrNull(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "string";
}

const VALID_FIELD_TYPES = new Set([
	"text",
	"email",
	"textarea",
	"number",
	"tel",
	"url",
	"date",
	"select",
	"radio",
	"checkbox",
	"checkbox-group",
	"file",
	"hidden",
]);

const VALID_SPAM_PROTECTION = new Set(["none", "honeypot", "turnstile"]);

function hasValidOptions(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(
				(option) =>
					isObject(option) &&
					typeof option.label === "string" &&
					typeof option.value === "string",
			))
	);
}

function isPublicFormField(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}

	return (
		typeof value.id === "string" &&
		typeof value.type === "string" &&
		VALID_FIELD_TYPES.has(value.type) &&
		typeof value.label === "string" &&
		typeof value.name === "string" &&
		typeof value.required === "boolean" &&
		(value.width === "full" || value.width === "half") &&
		isOptionalString(value.placeholder) &&
		isOptionalString(value.helpText) &&
		isOptionalString(value.defaultValue) &&
		hasValidOptions(value.options) &&
		(value.validation === undefined || isObject(value.validation)) &&
		(value.condition === undefined || isObject(value.condition))
	);
}

function isPublicFormPage(value: unknown): boolean {
	return (
		isObject(value) &&
		isOptionalString(value.title) &&
		Array.isArray(value.fields) &&
		value.fields.every(isPublicFormField)
	);
}

function isPublicFormSettings(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}

	return (
		typeof value.spamProtection === "string" &&
		VALID_SPAM_PROTECTION.has(value.spamProtection) &&
		typeof value.submitLabel === "string" &&
		isOptionalString(value.nextLabel) &&
		isOptionalString(value.prevLabel)
	);
}

function parsePublicFormDefinitionData(payload: unknown): PublicFormDefinition | null {
	if (!isObject(payload)) {
		return null;
	}

	if (payload.status !== "active") {
		return null;
	}

	if (
		typeof payload.name !== "string" ||
		typeof payload.slug !== "string" ||
		!Array.isArray(payload.pages) ||
		!payload.pages.every(isPublicFormPage) ||
		!isPublicFormSettings(payload.settings) ||
		!isOptionalStringOrNull(payload._turnstileSiteKey)
	) {
		return null;
	}

	return payload as unknown as PublicFormDefinition;
}

export function parsePublicFormDefinitionPayload(payload: unknown): PublicFormDefinition | null {
	if (!isObject(payload) || payload.success !== true) {
		return null;
	}

	return parsePublicFormDefinitionData(payload.data);
}

export async function parsePublicFormDefinitionResponse(
	response: Response,
): Promise<PublicFormDefinition | null> {
	if (!response.ok) {
		return null;
	}

	const form = await parseApiResponse<unknown>(response);
	return parsePublicFormDefinitionData(form);
}

function createPublicFormDefinitionRequest(formId: string, baseUrl: URL): Request {
	return new Request(new URL("/_emdash/api/plugins/emdash-forms/definition", baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: formId }),
	});
}

export async function loadPublicFormDefinition({
	formId,
	baseUrl,
	handlePublicPluginApiRoute,
	fetch: fetchImpl = fetch,
}: LoadPublicFormDefinitionOptions): Promise<PublicFormDefinition | null> {
	if (handlePublicPluginApiRoute) {
		try {
			return parsePublicFormDefinitionPayload(
				await handlePublicPluginApiRoute(
					"emdash-forms",
					"POST",
					"/definition",
					createPublicFormDefinitionRequest(formId, baseUrl),
				),
			);
		} catch (error) {
			console.warn("[emdash-forms] public definition dispatcher failed:", error);
			return null;
		}
	}

	return parsePublicFormDefinitionResponse(
		await fetchImpl(createPublicFormDefinitionRequest(formId, baseUrl)),
	);
}
