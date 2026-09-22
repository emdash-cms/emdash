import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../utils/render.tsx";

const mockGetPasskeyClientCapabilities = vi.fn();

vi.mock("../../src/lib/webauthn-environment", async () => {
	const actual = await vi.importActual("../../src/lib/webauthn-environment");
	return {
		...actual,
		detectPasskeyPlatform: () => "windows",
		getPasskeyClientCapabilities: () => mockGetPasskeyClientCapabilities(),
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

const { PasskeyRegistration } = await import("../../src/components/auth/PasskeyRegistration");

function registrationOptionsResponse() {
	return new Response(
		JSON.stringify({
			data: {
				options: {
					challenge: "AQ",
					rp: { id: "example.com", name: "Example" },
					user: { id: "AQ", name: "user@example.com", displayName: "User" },
					pubKeyCredParams: [{ type: "public-key", alg: -7 }],
				},
			},
		}),
		{ status: 200 },
	);
}

describe("PasskeyRegistration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetPasskeyClientCapabilities.mockResolvedValue({
			platformAuthenticator: true,
			hybridTransport: true,
		});
	});

	it("explains what a passkey is and where it is saved before opening system UI", async () => {
		const screen = await render(
			<PasskeyRegistration
				optionsEndpoint="/options"
				verifyEndpoint="/verify"
				onSuccess={() => {}}
				showEducation
			/>,
		);

		await expect
			.element(screen.getByText("With a passkey, you don’t need to remember complex passwords"))
			.toBeInTheDocument();
		await expect.element(screen.getByText("What is a passkey?")).toBeInTheDocument();
		await expect.element(screen.getByText("Where is it saved?")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Create passkey" }))
			.toBeInTheDocument();
	});

	it("explains the available choices instead of opening a confusing chooser without Hello", async () => {
		mockGetPasskeyClientCapabilities.mockResolvedValue({
			platformAuthenticator: false,
			hybridTransport: true,
		});

		const screen = await render(
			<PasskeyRegistration
				optionsEndpoint="/options"
				verifyEndpoint="/verify"
				onSuccess={() => {}}
				showEducation
			/>,
		);

		await expect
			.element(screen.getByText("No Windows Hello authenticator found"))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Set up Windows Hello" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Use another device" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Use a security key" }))
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create passkey" }).query()).toBeNull();

		await screen.getByRole("button", { name: "Set up Windows Hello" }).click();
		await expect
			.element(screen.getByRole("link", { name: "Open Windows settings" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "I've set it up — check again" }))
			.toBeInTheDocument();
	});

	it("asks the browser to prefer the hybrid flow after another device is chosen", async () => {
		mockGetPasskeyClientCapabilities.mockResolvedValue({
			platformAuthenticator: false,
			hybridTransport: true,
		});
		mockApiFetch
			.mockResolvedValueOnce(registrationOptionsResponse())
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: { success: true } }), { status: 200 }),
			);

		const create = vi.spyOn(navigator.credentials, "create").mockResolvedValue({
			id: "credential-id",
			rawId: new Uint8Array([1]).buffer,
			type: "public-key",
			authenticatorAttachment: "cross-platform",
			response: {
				clientDataJSON: new Uint8Array([1]).buffer,
				attestationObject: new Uint8Array([1]).buffer,
				getTransports: () => ["hybrid"],
			},
		} as unknown as PublicKeyCredential);

		const onSuccess = vi.fn();
		const screen = await render(
			<PasskeyRegistration
				optionsEndpoint="/options"
				verifyEndpoint="/verify"
				onSuccess={onSuccess}
				showEducation
				showSuccessStep
				successButtonText="Open dashboard"
			/>,
		);

		await screen.getByRole("button", { name: "Use another device" }).click();
		await screen.getByRole("button", { name: "Continue with another device" }).click();

		await vi.waitFor(() => {
			expect(create).toHaveBeenCalledOnce();
		});
		const request = create.mock.calls[0]?.[0] as CredentialCreationOptions & {
			publicKey: PublicKeyCredentialCreationOptions & { hints?: string[] };
		};
		expect(request.publicKey.hints).toEqual(["hybrid"]);
		await expect.element(screen.getByText("Passkey created")).toBeInTheDocument();
		expect(onSuccess).not.toHaveBeenCalled();
		await screen.getByRole("button", { name: "Open dashboard" }).click();
		expect(onSuccess).toHaveBeenCalledOnce();
	});
});
