/**
 * WebAuthn is only available in a browser "secure context": HTTPS, or special-cased
 * loopback hosts such as `http://localhost` / `http://127.0.0.1`.
 *
 * An origin like `http://emdash.local:8081` resolves to 127.0.0.1 but is still
 * **not** a secure context, so `PublicKeyCredential` is hidden — the same symptom
 * as an unsupported browser.
 */

export function isWebAuthnSecureContext(): boolean {
	return typeof window !== "undefined" && window.isSecureContext;
}

export function isPublicKeyCredentialConstructorAvailable(): boolean {
	return (
		typeof window !== "undefined" &&
		window.PublicKeyCredential !== undefined &&
		typeof window.PublicKeyCredential === "function"
	);
}

/** True when the page can use `navigator.credentials` for passkeys. */
export function isPasskeyEnvironmentUsable(): boolean {
	return isWebAuthnSecureContext() && isPublicKeyCredentialConstructorAvailable();
}
