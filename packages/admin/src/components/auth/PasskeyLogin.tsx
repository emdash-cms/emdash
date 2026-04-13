/**
 * PasskeyLogin - WebAuthn authentication component
 *
 * Handles the passkey login flow:
 * 1. Fetches authentication options from server
 * 2. Triggers browser's WebAuthn credential assertion
 * 3. Sends assertion back to server for verification
 *
 * Supports:
 * - Discoverable credentials (passkey autofill)
 * - Non-discoverable credentials (email-first flow)
 */

import { Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { apiFetch, parseApiResponse } from "../../lib/api/client";
import {
	isPasskeyEnvironmentUsable,
	isWebAuthnSecureContext,
} from "../../lib/webauthn-environment";

// ============================================================================
// Constants
// ============================================================================

const BASE64URL_DASH_REGEX = /-/g;
const BASE64URL_UNDERSCORE_REGEX = /_/g;
const BASE64_PLUS_REGEX = /\+/g;
const BASE64_SLASH_REGEX = /\//g;

// ============================================================================
// WebAuthn types
// ============================================================================
interface PublicKeyCredentialRequestOptionsJSON {
	challenge: string;
	rpId: string;
	timeout?: number;
	userVerification?: "discouraged" | "preferred" | "required";
	allowCredentials?: Array<{
		type: "public-key";
		id: string;
		transports?: AuthenticatorTransport[];
	}>;
}

interface AuthenticationResponse {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	};
	authenticatorAttachment?: "platform" | "cross-platform";
}

export interface PasskeyLoginProps {
	/** Endpoint to get authentication options */
	optionsEndpoint: string;
	/** Endpoint to verify authentication */
	verifyEndpoint: string;
	/** Called on successful authentication */
	onSuccess: (response: unknown) => void;
	/** Called on error */
	onError?: (error: Error) => void;
	/** Show email input for non-discoverable flow */
	showEmailInput?: boolean;
	/** Button text */
	buttonText?: string;
}

type LoginState =
	| { status: "idle" }
	| { status: "loading"; message: string }
	| { status: "error"; message: string }
	| { status: "success" };

/**
 * Check if conditional mediation (autofill) is supported
 */
async function isConditionalMediationSupported(): Promise<boolean> {
	if (!isPasskeyEnvironmentUsable()) return false;
	try {
		return (await PublicKeyCredential.isConditionalMediationAvailable?.()) ?? false;
	} catch {
		return false;
	}
}

/**
 * Convert base64url to ArrayBuffer
 */
function base64urlToBuffer(base64url: string): ArrayBuffer {
	const base64 = base64url
		.replace(BASE64URL_DASH_REGEX, "+")
		.replace(BASE64URL_UNDERSCORE_REGEX, "/");
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(base64 + padding);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

/**
 * Convert ArrayBuffer to base64url (with padding for @oslojs/encoding compatibility)
 */
function bufferToBase64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	const base64 = btoa(binary);
	// Convert to base64url but keep padding (required by @oslojs/encoding)
	return base64.replace(BASE64_PLUS_REGEX, "-").replace(BASE64_SLASH_REGEX, "_");
}

/**
 * PasskeyLogin Component
 */
export function PasskeyLogin({
	optionsEndpoint,
	verifyEndpoint,
	onSuccess,
	onError,
	showEmailInput = false,
	buttonText,
}: PasskeyLoginProps) {
	const { t } = useLingui();
	const resolvedButtonText = buttonText ?? t`Sign in with Passkey`;
	const [state, setState] = React.useState<LoginState>({ status: "idle" });
	const [email, setEmail] = React.useState("");
	const [supportsConditional, setSupportsConditional] = React.useState(false);

	const isSupported = React.useMemo(() => isPasskeyEnvironmentUsable(), []);
	const insecureContext = React.useMemo(
		() => typeof window !== "undefined" && !isWebAuthnSecureContext(),
		[],
	);

	// Check conditional mediation support
	React.useEffect(() => {
		void isConditionalMediationSupported().then(setSupportsConditional);
	}, []);

	const handleLogin = React.useCallback(
		async (useConditional = false) => {
			if (!isSupported) {
				setState({
					status: "error",
					message: insecureContext
						? t`Passkeys require HTTPS or http://localhost (with your port); this hostname is not a secure browser context.`
						: t`WebAuthn is not supported in this browser`,
				});
				return;
			}

			try {
				// Step 1: Get authentication options from server
				setState({ status: "loading", message: t`Preparing...` });

				const optionsResponse = await apiFetch(optionsEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email: email || undefined }),
				});

				const optionsData = await parseApiResponse<{
					options: PublicKeyCredentialRequestOptionsJSON;
				}>(optionsResponse, "Failed to get authentication options");
				const { options } = optionsData;

				// Step 2: Get assertion from browser
				setState({ status: "loading", message: t`Waiting for passkey...` });

				// Convert options to the format expected by the browser
				const publicKeyOptions: PublicKeyCredentialRequestOptions = {
					challenge: base64urlToBuffer(options.challenge),
					rpId: options.rpId,
					timeout: options.timeout,
					userVerification: options.userVerification,
					allowCredentials: options.allowCredentials?.map((cred) => ({
						type: cred.type,
						id: base64urlToBuffer(cred.id),
						transports: cred.transports,
					})),
				};

				const credentialOptions: CredentialRequestOptions = {
					publicKey: publicKeyOptions,
					// Use conditional mediation if supported and requested
					...(useConditional && supportsConditional
						? { mediation: "conditional" as CredentialMediationRequirement }
						: {}),
				};

				const rawCredential = await navigator.credentials.get(credentialOptions);

				if (!rawCredential) {
					const message = "No credential returned from authenticator";
					setState({ status: "error", message });
					onError?.(new Error(message));
					return;
				}

				// Step 3: Send credential to server for verification
				setState({ status: "loading", message: t`Verifying...` });

				// navigator.credentials.get() with publicKey returns PublicKeyCredential
				const credential = rawCredential as PublicKeyCredential;
				const assertionResponse = credential.response as AuthenticatorAssertionResponse;

				// authenticatorAttachment exists at runtime on PublicKeyCredential but isn't in the base type definition
				const rawAttachment =
					"authenticatorAttachment" in credential ? credential.authenticatorAttachment : undefined;
				const authenticatorAttachment =
					rawAttachment === "platform" || rawAttachment === "cross-platform"
						? rawAttachment
						: undefined;

				const authenticationResponse: AuthenticationResponse = {
					id: credential.id,
					rawId: bufferToBase64url(credential.rawId),
					type: "public-key",
					response: {
						clientDataJSON: bufferToBase64url(assertionResponse.clientDataJSON),
						authenticatorData: bufferToBase64url(assertionResponse.authenticatorData),
						signature: bufferToBase64url(assertionResponse.signature),
						userHandle: assertionResponse.userHandle
							? bufferToBase64url(assertionResponse.userHandle)
							: undefined,
					},
					authenticatorAttachment,
				};

				const verifyResponse = await apiFetch(verifyEndpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ credential: authenticationResponse }),
				});

				const result = await parseApiResponse<unknown>(
					verifyResponse,
					"Failed to verify authentication",
				);

				setState({ status: "success" });
				onSuccess(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Authentication failed";

				// Handle specific WebAuthn errors
				let userMessage = message;
				if (error instanceof DOMException) {
					switch (error.name) {
						case "NotAllowedError":
							userMessage = t`Authentication was cancelled or timed out. Please try again.`;
							break;
						case "InvalidStateError":
							userMessage = t`No matching passkey found for this account.`;
							break;
						case "NotSupportedError":
							userMessage = t`Your device doesn't support the required security features.`;
							break;
						case "SecurityError":
							userMessage = t`Security error. Make sure you're on a secure connection.`;
							break;
						case "AbortError":
							// User cancelled - don't show error
							setState({ status: "idle" });
							return;
						default:
							userMessage = t`Authentication error: ${error.message}`;
					}
				}

				setState({ status: "error", message: userMessage });
				onError?.(new Error(userMessage));
			}
		},
		[
			isSupported,
			insecureContext,
			optionsEndpoint,
			verifyEndpoint,
			email,
			supportsConditional,
			onSuccess,
			onError,
			t,
		],
	);

	if (!isSupported) {
		return (
			<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
				<h3 className="font-medium text-kumo-danger">{t`Passkeys Not Available Here`}</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					{insecureContext ? (
						<>
							{t`Passkeys require a`}{" "}
							<strong className="text-kumo-default">{t`secure context`}</strong>
							{t`: use`} <strong className="text-kumo-default">HTTPS</strong>
							{t`, or open the admin at`}{" "}
							<strong className="text-kumo-default">http://localhost</strong>{" "}
							{t`(with your dev port).`}
							{t`Plain`} <code className="text-xs">http://</code>{" "}
							{t`on a custom hostname is not treated as secure, even on loopback.`}
						</>
					) : (
						<>
							{t`Your browser doesn't support passkeys. Please use a modern browser like Chrome, Safari, Firefox, or Edge.`}
						</>
					)}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Email input (optional - for non-discoverable credentials) */}
			{showEmailInput && (
				<div>
					<Input
						label={t`Email (optional)`}
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder={t`you@example.com`}
						disabled={state.status === "loading"}
						autoComplete="username webauthn"
					/>
					<p className="mt-1 text-xs text-kumo-subtle">
						{t`Leave blank to use a discoverable passkey.`}
					</p>
				</div>
			)}

			{/* Error message */}
			{state.status === "error" && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">
					{state.message}
				</div>
			)}

			{/* Login button */}
			<Button
				type="button"
				onClick={() => handleLogin(false)}
				loading={state.status === "loading"}
				className="w-full justify-center"
				variant="primary"
			>
				{state.status === "loading" ? <>{state.message}</> : resolvedButtonText}
			</Button>

			{/* Help text */}
			<p className="text-xs text-kumo-subtle text-center">
				{t`Use your device's biometric authentication, security key, or PIN to sign in.`}
			</p>
		</div>
	);
}
