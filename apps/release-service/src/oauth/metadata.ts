import type { OAuthConfiguration } from "../config.js";

interface PublicAssertionJwk {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
	kid: string;
	alg: "ES256";
	use: "sig";
}

export function getClientMetadata(configuration: OAuthConfiguration) {
	return configuration.clientMetadata;
}

export function getPublicJwks(configuration: OAuthConfiguration): {
	keys: readonly PublicAssertionJwk[];
} {
	return {
		keys: configuration.assertionKeys.map((key) => {
			if (key.kty !== "EC" || key.crv !== "P-256" || key.alg !== "ES256") {
				throw new Error("Invalid configured assertion key");
			}
			return {
				kty: "EC",
				crv: "P-256",
				x: key.x,
				y: key.y,
				kid: key.kid,
				alg: "ES256",
				use: "sig",
			};
		}),
	};
}

export function publicOAuthJson(value: unknown): Response {
	return Response.json(value, {
		headers: {
			"cache-control": "public, max-age=300",
			"content-type": "application/json; charset=utf-8",
		},
	});
}
