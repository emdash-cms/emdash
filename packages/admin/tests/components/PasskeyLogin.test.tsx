import { i18n } from "@lingui/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PasskeyLogin } from "../../src/components/auth/PasskeyLogin.js";
import { messages as jaMessages } from "../../src/locales/ja/messages.mjs";
import { render } from "../utils/render.js";

const publicKeyCredentialDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"PublicKeyCredential",
);
const credentialsDescriptor = Object.getOwnPropertyDescriptor(navigator, "credentials");

beforeAll(() => {
	Object.defineProperty(window, "PublicKeyCredential", {
		configurable: true,
		value: function PublicKeyCredential() {},
	});
	Object.defineProperty(navigator, "credentials", {
		configurable: true,
		value: {
			get: vi.fn().mockResolvedValue({
				id: "credential-id",
				rawId: new Uint8Array([1]).buffer,
				type: "public-key",
				response: {
					clientDataJSON: new Uint8Array([2]).buffer,
					authenticatorData: new Uint8Array([3]).buffer,
					signature: new Uint8Array([4]).buffer,
					userHandle: null,
				},
			}),
		},
	});
	i18n.loadAndActivate({ locale: "ja", messages: jaMessages });
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	if (publicKeyCredentialDescriptor) {
		Object.defineProperty(window, "PublicKeyCredential", publicKeyCredentialDescriptor);
	} else {
		Reflect.deleteProperty(window, "PublicKeyCredential");
	}
	if (credentialsDescriptor) {
		Object.defineProperty(navigator, "credentials", credentialsDescriptor);
	} else {
		Reflect.deleteProperty(navigator, "credentials");
	}
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("PasskeyLogin", () => {
	it("localizes disabled-account verification errors", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							options: {
								challenge: "AQ==",
								rpId: "localhost",
							},
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: false,
						error: { code: "ACCOUNT_DISABLED", message: "Account disabled" },
					}),
					{ status: 403 },
				),
			);
		const onSuccess = vi.fn();
		const onError = vi.fn();
		const screen = await render(
			<PasskeyLogin
				optionsEndpoint="/options"
				verifyEndpoint="/verify"
				onSuccess={onSuccess}
				onError={onError}
			/>,
		);

		await screen.getByRole("button", { name: "パスキーでサインイン" }).click();

		await expect.element(screen.getByText("認証に失敗しました")).toBeInTheDocument();
		expect(screen.getByText("Account disabled").query()).toBeNull();
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(new Error("認証に失敗しました"));
	});
});
