/**
 * PasskeyRegistration - WebAuthn credential registration component
 *
 * Handles the passkey registration flow:
 * 1. Fetches registration options from server
 * 2. Triggers browser's WebAuthn credential creation
 * 3. Sends attestation back to server for verification
 *
 * Used in:
 * - Setup wizard (first admin creation)
 * - User settings (adding additional passkeys)
 */

import { Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { apiFetch, parseApiResponse } from "../../lib/api/client";

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
interface PublicKeyCredentialCreationOptionsJSON {
	challenge: string;
	rp: {
		name: string;
		id: string;
	};
	user: {
		id: string;
		name: string;
		displayName: string;
	};
	pubKeyCredParams: Array<{
		type: "public-key";
		alg: number;
	}>;
	timeout?: number;
	attestation?: "none" | "indirect" | "direct";
	authenticatorSelection?: {
		authenticatorAttachment?: "platform" | "cross-platform";
		residentKey?: "discouraged" | "preferred" | "required";
		requireResidentKey?: boolean;
		userVerification?: "discouraged" | "preferred" | "required";
	};
	excludeCredentials?: Array<{
		type: "public-key";
		id: string;
		transports?: AuthenticatorTransport[];
	}>;
}

interface RegistrationResponse {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports?: AuthenticatorTransport[];
	};
	authenticatorAttachment?: "platform" | "cross-platform";
}

export interface PasskeyRegistrationProps {
	/** Endpoint to get registration options */
	optionsEndpoint: string;
	/** Endpoint to verify registration */
	verifyEndpoint: string;
	/** Called on successful registration */
	onSuccess: (response: unknown) => void;
	/** Called on error */
	onError?: (error: Error) => void;
	/** Button text */
	buttonText?: string;
	/** Show passkey name input */
	showNameInput?: boolean;
	/** Additional data to send with requests */
	additionalData?: Record<string, unknown>;
}

const EMPTY_DATA: Record<string, unknown> = {};

type RegistrationState =
	| { status: "idle" }
	| { status: "loading"; message: string }
	| { status: "error"; message: string }
	| { status: "success" };

/**
 * Check if WebAuthn is supported in the current browser
 */
function isWebAuthnSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		window.PublicKeyCredential !== undefined &&
		typeof window.PublicKeyCredential === "function"
	);
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
 * PasskeyRegistration Component
 */
export function PasskeyRegistration({
	optionsEndpoint,
	verifyEndpoint,
	onSuccess,
	onError,
	buttonText,
	showNameInput = false,
	additionalData = EMPTY_DATA,
}: PasskeyRegistrationProps) {
	const { t } = useLingui();
	const resolvedButtonText = buttonText ?? t`Register Passkey`;
	const [state, setState] = React.useState<RegistrationState>({
		status: "idle",
	});
	const [passkeyName, setPasskeyName] = React.useState("");

	// Check WebAuthn support on mount
	const isSupported = React.useMemo(() => isWebAuthnSupported(), []);

	const handleRegister = React.useCallback(async () => {
		if (!isSupported) {
			setState({
				status: "error",
				message: t`WebAuthn is not supported in this browser`,
			});
			return;
		}

		try {
			// Step 1: Get registration options from server
			setState({ status: "loading", message: t`Preparing registration...` });

			const optionsResponse = await apiFetch(optionsEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(additionalData),
			});

			const optionsData = await parseApiResponse<{
				options: PublicKeyCredentialCreationOptionsJSON;
			}>(optionsResponse, "Failed to get registration options");
			const { options } = optionsData;

			// Step 2: Create credential with browser
			setState({ status: "loading", message: t`Waiting for passkey...` });

			// Convert options to the format expected by the browser
			const publicKeyOptions: PublicKeyCredentialCreationOptions = {
				challenge: base64urlToBuffer(options.challenge),
				rp: options.rp,
				user: {
					id: base64urlToBuffer(options.user.id),
					name: options.user.name,
					displayName: options.user.displayName,
				},
				pubKeyCredParams: options.pubKeyCredParams,
				timeout: options.timeout,
				attestation: options.attestation,
				authenticatorSelection: options.authenticatorSelection,
				excludeCredentials: options.excludeCredentials?.map((cred) => ({
					type: cred.type,
					id: base64urlToBuffer(cred.id),
					transports: cred.transports,
				})),
			};

			const rawCredential = await navigator.credentials.create({
				publicKey: publicKeyOptions,
			});

			if (!rawCredential) {
				throw new Error("No credential returned from authenticator");
			}

			// Step 3: Send credential to server for verification
			setState({ status: "loading", message: t`Verifying...` });

			// navigator.credentials.create() with publicKey returns PublicKeyCredential
			const credential = rawCredential as PublicKeyCredential;
			const attestationResponse = credential.response as AuthenticatorAttestationResponse;

			// authenticatorAttachment exists at runtime on PublicKeyCredential but isn't in the base type definition
			const rawAttachment =
				"authenticatorAttachment" in credential ? credential.authenticatorAttachment : undefined;
			const authenticatorAttachment =
				rawAttachment === "platform" || rawAttachment === "cross-platform"
					? rawAttachment
					: undefined;

			const registrationResponse: RegistrationResponse = {
				id: credential.id,
				rawId: bufferToBase64url(credential.rawId),
				type: "public-key",
				response: {
					clientDataJSON: bufferToBase64url(attestationResponse.clientDataJSON),
					attestationObject: bufferToBase64url(attestationResponse.attestationObject),
					transports: attestationResponse.getTransports?.() as AuthenticatorTransport[] | undefined,
				},
				authenticatorAttachment,
			};

			const verifyResponse = await apiFetch(verifyEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					credential: registrationResponse,
					name: passkeyName || undefined,
					...additionalData,
				}),
			});

			const result = await parseApiResponse<unknown>(
				verifyResponse,
				"Failed to verify registration",
			);

			setState({ status: "success" });
			onSuccess(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : t`Registration failed`;

			// Handle specific WebAuthn errors
			let userMessage = message;
			if (error instanceof DOMException) {
				switch (error.name) {
					case "NotAllowedError":
						userMessage = t`Registration was cancelled or timed out. Please try again.`;
						break;
					case "InvalidStateError":
						userMessage = t`This passkey is already registered on this device.`;
						break;
					case "NotSupportedError":
						userMessage = t`Your device doesn't support the required security features.`;
						break;
					case "SecurityError":
						userMessage = t`Security error. Make sure you're on a secure connection.`;
						break;
					default:
						userMessage = t`Authentication error: ${error.message}`;
				}
			}

			setState({ status: "error", message: userMessage });
			onError?.(new Error(userMessage));
		}
	}, [
		isSupported,
		optionsEndpoint,
		verifyEndpoint,
		additionalData,
		passkeyName,
		onSuccess,
		onError,
	]);

	// Not supported message
	if (!isSupported) {
		return (
			<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
				<h3 className="font-medium text-kumo-danger">{t`Passkeys Not Supported`}</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					{t`Your browser doesn't support passkeys. Please use a modern browser like Chrome, Safari, Firefox, or Edge.`}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Passkey name input (optional) */}
			{showNameInput && (
				<div>
					<Input
						label={t`Passkey Name (optional)`}
						type="text"
						value={passkeyName}
						onChange={(e) => setPasskeyName(e.target.value)}
						placeholder={t`e.g., MacBook Pro, iPhone`}
						disabled={state.status === "loading"}
					/>
					<p className="mt-1 text-xs text-kumo-subtle">
						{t`Give this passkey a name to help you identify it later.`}
					</p>
				</div>
			)}

			{/* Error message */}
			{state.status === "error" && (
				<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">
					{state.message}
				</div>
			)}

			{/* Success message */}
			{state.status === "success" && (
				<div className="rounded-lg bg-green-500/10 p-4 text-sm text-green-700 dark:text-green-400">
					{t`Passkey registered successfully!`}
				</div>
			)}

			{/* Register button */}
			<Button
				type="button"
				onClick={handleRegister}
				loading={state.status === "loading"}
				className="w-full justify-center"
				variant="primary"
			>
				{state.status === "loading" ? <>{state.message}</> : resolvedButtonText}
			</Button>

			{/* Help text */}
			<p className="text-xs text-kumo-subtle text-center">
				{t`You'll be prompted to use your device's biometric authentication, security key, or PIN.`}
			</p>
		</div>
	);
}
