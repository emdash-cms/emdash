/**
 * Chrome DevTools virtual WebAuthn authenticator for passkey e2e.
 * Chromium-only (CDP). See https://developer.chrome.com/docs/devtools/webauthn/
 */
import type { Page } from "@playwright/test";

export async function addVirtualWebAuthnAuthenticator(page: Page): Promise<() => Promise<void>> {
	const session = await page.context().newCDPSession(page);
	await session.send("WebAuthn.enable");
	const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});

	return async () => {
		try {
			await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
		} catch {
			// session may already be closed
		}
		try {
			await session.detach();
		} catch {
			// ignore
		}
	};
}
