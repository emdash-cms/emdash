import { describe, it, expect, afterEach } from "vitest";

import {
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
});
