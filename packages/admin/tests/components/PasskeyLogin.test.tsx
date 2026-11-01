import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/webauthn-environment", async () => {
	const actual = await vi.importActual("../../src/lib/webauthn-environment");
	return {
		...actual,
		isPasskeyEnvironmentUsable: () => true,
		isWebAuthnSecureContext: () => true,
	};
});

const mockApiFetch = vi.fn();

vi.mock("../../src/lib/api/client", async () => {
	const actual = await vi.importActual("../../src/lib/api/client");
	return {
		...actual,
		apiFetch: (...args: unknown[]) => mockApiFetch(...args),
	};
});

const { PasskeyLogin } = await import("../../src/components/auth/PasskeyLogin");

const RP_ID = "example.com";
const SIGNALS = ["signalUnknownCredential", "signalCurrentUserDetails"] as const;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function bytes(value: string): ArrayBuffer {
	return new TextEncoder().encode(value).buffer;
}

const assertion = {
	id: "credential-1",
	rawId: bytes("credential-1"),
	type: "public-key",
	authenticatorAttachment: "platform",
	response: {
		clientDataJSON: bytes("{}"),
		authenticatorData: bytes("data"),
		signature: bytes("signature"),
		userHandle: bytes("user_1"),
	},
};

describe("PasskeyLogin", () => {
	const originals = new Map<string, PropertyDescriptor | undefined>();
	const signals = {
		signalUnknownCredential: vi.fn(async () => undefined),
		signalCurrentUserDetails: vi.fn(async () => undefined),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		for (const name of SIGNALS) {
			originals.set(name, Object.getOwnPropertyDescriptor(window.PublicKeyCredential, name));
			Object.defineProperty(window.PublicKeyCredential, name, {
				value: signals[name],
				configurable: true,
				writable: true,
			});
		}
		Object.defineProperty(navigator.credentials, "get", {
			value: vi.fn(async () => assertion),
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		for (const name of SIGNALS) {
			const original = originals.get(name);
			if (original) Object.defineProperty(window.PublicKeyCredential, name, original);
			else Reflect.deleteProperty(window.PublicKeyCredential, name);
		}
		Reflect.deleteProperty(navigator.credentials, "get");
	});

	it("asks the browser to forget a passkey the site no longer recognizes", async () => {
		mockApiFetch
			.mockResolvedValueOnce(json({ data: { options: { challenge: "AQ", rpId: RP_ID } } }))
			.mockResolvedValueOnce(
				json(
					{ error: { code: "CREDENTIAL_NOT_FOUND", message: "Passkey is not registered" } },
					401,
				),
			);
		const onSuccess = vi.fn();
		const screen = await render(
			<PasskeyLogin optionsEndpoint="/options" verifyEndpoint="/verify" onSuccess={onSuccess} />,
		);

		await screen.getByRole("button", { name: "Sign in with Passkey" }).click();

		await expect
			.element(
				screen.getByText("This passkey is no longer registered on this site.", { exact: false }),
			)
			.toBeInTheDocument();
		expect(signals.signalUnknownCredential).toHaveBeenCalledWith({
			rpId: RP_ID,
			credentialId: "credential-1",
		});
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("refreshes the account name the credential manager shows after signing in", async () => {
		mockApiFetch
			.mockResolvedValueOnce(json({ data: { options: { challenge: "AQ", rpId: RP_ID } } }))
			.mockResolvedValueOnce(
				json({
					data: {
						success: true,
						user: { id: "user_1", email: "editor@example.com", name: "Editor" },
					},
				}),
			);
		const onSuccess = vi.fn();
		const screen = await render(
			<PasskeyLogin optionsEndpoint="/options" verifyEndpoint="/verify" onSuccess={onSuccess} />,
		);

		await screen.getByRole("button", { name: "Sign in with Passkey" }).click();

		await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
		expect(signals.signalCurrentUserDetails).toHaveBeenCalledWith({
			rpId: RP_ID,
			userId: "dXNlcl8x",
			name: "editor@example.com",
			displayName: "Editor",
		});
		expect(signals.signalUnknownCredential).not.toHaveBeenCalled();
	});
});
