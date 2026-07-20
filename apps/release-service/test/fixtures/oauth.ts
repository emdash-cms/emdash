import type { ConfigurationBindings } from "../../src/config.js";

export const ASSERTION_KEY_1 = {
	kty: "EC",
	x: "ltusUjVlZKJd0aB08R9ofpA618lL6Bh5Vklz1BnItBQ",
	y: "SOhTX8HsvUgesPwUhB1jF-YIyoqv-3rU3a2awb-pvrU",
	crv: "P-256",
	d: "F_epxvQa-byikHSElS85WQYumK5MplPRSrqOo-Q3U5w",
	kid: "assertion-2026-01",
	alg: "ES256",
	use: "sig",
} as const;

export const ASSERTION_KEY_2 = {
	kty: "EC",
	x: "3MPONnVYNjZG1cYlDyrabO4Y4Raqpq4bbhxWuVDMMrg",
	y: "dkRyxzxRco-qe5SIgmgS6N66GFx-cSLzkUCHvua3KbE",
	crv: "P-256",
	d: "EG0ysjQnY6YhBfYdwfzV4FmBIsQr99XOLLEA-c9F-rE",
	kid: "assertion-2026-02",
	alg: "ES256",
	use: "sig",
} as const;

export const TEST_ASSERTION_KEYSET = JSON.stringify({
	active: ASSERTION_KEY_2.kid,
	keys: [ASSERTION_KEY_1, ASSERTION_KEY_2],
});

export const TEST_ENCRYPTION_KEYRING =
	'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}';

export const TEST_BINDINGS = {
	PUBLIC_ORIGIN: "https://release.example.invalid",
	ALLOWED_ORIGINS: '["https://release.example.invalid"]',
	ALLOWED_PUBLISHERS: '{"mode":"all"}',
	DEPLOYMENT_POLICY: "hosted",
	ENCRYPTION_KEYRING: TEST_ENCRYPTION_KEYRING,
	OAUTH_REDIRECT_URIS: '["https://release.example.invalid/oauth/callback"]',
	OAUTH_ASSERTION_KEYSET: TEST_ASSERTION_KEYSET,
} satisfies ConfigurationBindings;
