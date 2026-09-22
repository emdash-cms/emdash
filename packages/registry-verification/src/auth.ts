export const UNSUPPORTED_AUTH_MESSAGE =
	"This release requires an authentication method the client does not support.";

export function unsupportedAuthDetails(auth: unknown): { hintUrl: string } | undefined {
	if (!isRecord(auth) || typeof auth.hint_url !== "string" || auth.hint_url.length > 2048) {
		return undefined;
	}
	try {
		const url = new URL(auth.hint_url);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return { hintUrl: url.href };
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
