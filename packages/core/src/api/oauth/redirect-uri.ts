/**
 * Validate a redirect URI per OAuth 2.1 security requirements.
 *
 * Allows localhost / loopback redirect URIs over HTTP for native clients,
 * and any HTTPS URL for web-based flows.
 */
export function validateRedirectUri(uri: string): string | null {
	try {
		const url = new URL(uri);

		// Reject protocol-relative URLs
		if (uri.startsWith("//")) {
			return "Protocol-relative redirect URIs are not allowed";
		}

		// Allow localhost/loopback over HTTP (for desktop MCP clients)
		if (url.protocol === "http:") {
			const host = url.hostname;
			if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") {
				return null;
			}
			return "HTTP redirect URIs are only allowed for localhost";
		}

		// Allow HTTPS
		if (url.protocol === "https:") {
			return null;
		}

		return `Unsupported redirect URI scheme: ${url.protocol}`;
	} catch {
		return "Invalid redirect URI";
	}
}
