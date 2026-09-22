import { describe, it, expect, afterEach, vi } from "vitest";

import {
	detectPasskeyPlatform,
	getPasskeyClientCapabilities,
	isPasskeyEnvironmentUsable,
	isPublicKeyCredentialConstructorAvailable,
	isWebAuthnSecureContext,
} from "../../src/lib/webauthn-environment";

describe("webauthn-environment", () => {
	const origPk = globalThis.window.PublicKeyCredential;
	const desc = Object.getOwnPropertyDescriptor(globalThis.window, "isSecureContext");

	afterEach(() => {
		if (origPk === undefined) {
			delete (globalThis.window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
		} else {
			Object.defineProperty(globalThis.window, "PublicKeyCredential", {
				value: origPk,
				configurable: true,
				writable: true,
			});
		}
		if (desc) Object.defineProperty(globalThis.window, "isSecureContext", desc);
	});

	it("is usable only when secure context and PublicKeyCredential constructor exist", () => {
		Object.defineProperty(globalThis.window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		Object.defineProperty(globalThis.window, "PublicKeyCredential", {
			value: function PublicKeyCredential() {},
			configurable: true,
			writable: true,
		});
		expect(isWebAuthnSecureContext()).toBe(true);
		expect(isPublicKeyCredentialConstructorAvailable()).toBe(true);
		expect(isPasskeyEnvironmentUsable()).toBe(true);
	});

	it("is not usable in an insecure context even if PublicKeyCredential is defined", () => {
		Object.defineProperty(globalThis.window, "isSecureContext", {
			value: false,
			configurable: true,
		});
		Object.defineProperty(globalThis.window, "PublicKeyCredential", {
			value: function PublicKeyCredential() {},
			configurable: true,
			writable: true,
		});
		expect(isWebAuthnSecureContext()).toBe(false);
		expect(isPasskeyEnvironmentUsable()).toBe(false);
	});

	it("reports platform and hybrid authenticator capabilities", async () => {
		Object.defineProperty(globalThis.window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		const getClientCapabilities = vi.fn().mockResolvedValue({
			userVerifyingPlatformAuthenticator: false,
			hybridTransport: true,
		});
		Object.defineProperty(globalThis.window, "PublicKeyCredential", {
			value: Object.assign(function PublicKeyCredential() {}, { getClientCapabilities }),
			configurable: true,
			writable: true,
		});

		await expect(getPasskeyClientCapabilities()).resolves.toEqual({
			platformAuthenticator: false,
			hybridTransport: true,
		});
		expect(getClientCapabilities).toHaveBeenCalledOnce();
	});

	it("falls back to the older platform-authenticator capability check", async () => {
		Object.defineProperty(globalThis.window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		const isUserVerifyingPlatformAuthenticatorAvailable = vi.fn().mockResolvedValue(true);
		Object.defineProperty(globalThis.window, "PublicKeyCredential", {
			value: Object.assign(function PublicKeyCredential() {}, {
				isUserVerifyingPlatformAuthenticatorAvailable,
			}),
			configurable: true,
			writable: true,
		});

		await expect(getPasskeyClientCapabilities()).resolves.toEqual({
			platformAuthenticator: true,
			hybridTransport: null,
		});
	});

	it("uses platform detection only to tailor explanatory copy", () => {
		expect(detectPasskeyPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
		expect(detectPasskeyPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macos");
		expect(
			detectPasskeyPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148"),
		).toBe("ios");
		expect(detectPasskeyPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
	});
});
