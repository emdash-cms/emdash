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

export type PasskeyPlatform = "windows" | "macos" | "ios" | "android" | "other";

export interface PasskeyClientCapabilities {
	platformAuthenticator: boolean | null;
	hybridTransport: boolean | null;
}

type CapabilityMethod = () => Promise<unknown>;

function getCapabilityMethod(name: string): CapabilityMethod | null {
	if (!isPublicKeyCredentialConstructorAvailable()) return null;
	const value: unknown = Reflect.get(window.PublicKeyCredential, name);
	if (typeof value !== "function") return null;
	return () => Reflect.apply(value, window.PublicKeyCredential, []);
}

function readBooleanCapability(value: unknown, name: string): boolean | null {
	if (typeof value !== "object" || value === null) return null;
	const capability: unknown = Reflect.get(value, name);
	return typeof capability === "boolean" ? capability : null;
}

/**
 * Detect authenticator capabilities before opening browser-owned WebAuthn UI.
 * `null` means the browser cannot report that capability, so callers should
 * retain the ordinary browser chooser rather than assuming it is unavailable.
 */
export async function getPasskeyClientCapabilities(): Promise<PasskeyClientCapabilities> {
	if (!isPasskeyEnvironmentUsable()) {
		return { platformAuthenticator: null, hybridTransport: null };
	}

	let platformAuthenticator: boolean | null = null;
	let hybridTransport: boolean | null = null;
	const getClientCapabilities = getCapabilityMethod("getClientCapabilities");
	if (getClientCapabilities) {
		try {
			const capabilities = await getClientCapabilities();
			platformAuthenticator = readBooleanCapability(
				capabilities,
				"userVerifyingPlatformAuthenticator",
			);
			hybridTransport = readBooleanCapability(capabilities, "hybridTransport");
		} catch {
			// Older capability detection below may still be available.
		}
	}

	if (platformAuthenticator === null) {
		const isPlatformAuthenticatorAvailable = getCapabilityMethod(
			"isUserVerifyingPlatformAuthenticatorAvailable",
		);
		if (isPlatformAuthenticatorAvailable) {
			try {
				const available = await isPlatformAuthenticatorAvailable();
				platformAuthenticator = typeof available === "boolean" ? available : null;
			} catch {
				platformAuthenticator = null;
			}
		}
	}

	return { platformAuthenticator, hybridTransport };
}

/** Platform is only a copy hint; authenticator capability controls behavior. */
export function detectPasskeyPlatform(
	userAgent = globalThis.navigator?.userAgent ?? "",
): PasskeyPlatform {
	const normalized = userAgent.toLowerCase();
	if (normalized.includes("android")) return "android";
	if (
		normalized.includes("iphone") ||
		normalized.includes("ipad") ||
		(normalized.includes("macintosh") && normalized.includes("mobile"))
	) {
		return "ios";
	}
	if (normalized.includes("windows")) return "windows";
	if (normalized.includes("macintosh") || normalized.includes("mac os")) return "macos";
	return "other";
}
