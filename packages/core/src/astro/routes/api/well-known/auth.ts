/**
 * GET /_emdash/.well-known/auth
 *
 * Auth discovery endpoint. Returns available auth mechanisms.
 * Public, unauthenticated. Used by CLI to determine how to authenticate.
 */

import type { APIRoute } from "astro";

import { getAuthMode } from "#auth/mode.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	// Build discovery response
	const config = emdash?.config;
	const authMode = config ? getAuthMode(config) : null;

	const isExternal = authMode?.type === "external";

	// Try to read site name from DB options
	let siteName = "EmDash";
	if (emdash?.db) {
		try {
			const options = new OptionsRepository(emdash.db);
			siteName = (await options.get<string>("emdash:site_title")) || "EmDash";
		} catch {
			// DB may not be initialized yet
		}
	}

	const response: Record<string, unknown> = {
		instance: {
			name: siteName,
			version: "0.1.0",
		},
		auth: {
			mode: isExternal ? "external" : "passkey",
			...(isExternal && authMode.type === "external"
				? { external_provider: authMode.entrypoint }
				: {}),
			methods: {
				device_flow: !isExternal
					? {
							client_id: "emdash-cli",
							device_authorization_endpoint: "/_emdash/api/oauth/device/code",
							token_endpoint: "/_emdash/api/oauth/device/token",
						}
					: undefined,
				authorization_code: !isExternal
					? {
							authorization_endpoint: "/_emdash/oauth/authorize",
							token_endpoint: "/_emdash/api/oauth/token",
						}
					: undefined,
				api_tokens: true,
			},
		},
	};

	return Response.json(response, {
		headers: {
			"Cache-Control": "no-store",
		},
	});
};
