import { parseApiResponse } from "emdash/plugin-utils";

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

export type PublicPluginApiRouteHandler = (
	pluginId: string,
	method: string,
	path: string,
	request: Request,
) => Promise<unknown>;

interface LoadPublicFormDefinitionOptions {
	formId: string;
	baseUrl: URL;
	handlePluginApiRoute?: PublicPluginApiRouteHandler;
	fetch?: (input: Request) => Promise<Response>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parsePublicFormDefinitionPayload(payload: unknown): PublicFormDefinition | null {
	if (!isObject(payload)) {
		return null;
	}

	if ("success" in payload) {
		if (payload.success !== true) {
			return null;
		}
		return parsePublicFormDefinitionPayload(payload.data);
	}

	if ("data" in payload) {
		return parsePublicFormDefinitionPayload(payload.data);
	}

	if (payload.status !== "active") {
		return null;
	}

	return payload as unknown as PublicFormDefinition;
}

export async function parsePublicFormDefinitionResponse(
	response: Response,
): Promise<PublicFormDefinition | null> {
	if (!response.ok) {
		return null;
	}

	const form = await parseApiResponse<PublicFormDefinition | undefined>(response);
	return parsePublicFormDefinitionPayload(form);
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
	handlePluginApiRoute,
	fetch: fetchImpl = fetch,
}: LoadPublicFormDefinitionOptions): Promise<PublicFormDefinition | null> {
	if (handlePluginApiRoute) {
		try {
			return parsePublicFormDefinitionPayload(
				await handlePluginApiRoute(
					"emdash-forms",
					"POST",
					"/definition",
					createPublicFormDefinitionRequest(formId, baseUrl),
				),
			);
		} catch {
			// Fall back to HTTP fetch for older runtimes or unexpected dispatcher failures.
		}
	}

	return parsePublicFormDefinitionResponse(
		await fetchImpl(createPublicFormDefinitionRequest(formId, baseUrl)),
	);
}
