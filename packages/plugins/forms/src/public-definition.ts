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

export async function parsePublicFormDefinitionResponse(
	response: Response,
): Promise<PublicFormDefinition | null> {
	if (!response.ok) {
		return null;
	}

	const form = await parseApiResponse<PublicFormDefinition | undefined>(response);
	if (!form || form.status !== "active") {
		return null;
	}

	return form;
}
