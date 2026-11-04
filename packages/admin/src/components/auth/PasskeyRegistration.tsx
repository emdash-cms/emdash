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

import { Button, Input, LinkButton, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	DeviceMobile,
	Fingerprint,
	Info,
	Key,
	ShieldCheck,
	Usb,
	WindowsLogo,
} from "@phosphor-icons/react";
import * as React from "react";

import { apiFetch, parseApiResponse } from "../../lib/api/client";
import {
	detectPasskeyPlatform,
	getPasskeyClientCapabilities,
	isPasskeyEnvironmentUsable,
	isWebAuthnSecureContext,
} from "../../lib/webauthn-environment";
import type { PasskeyClientCapabilities, PasskeyPlatform } from "../../lib/webauthn-environment";
import { InsecurePasskeyContextMessage } from "./PasskeyContextMessage.js";

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
	hints?: PasskeyPreference[];
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
	/** Show researched onboarding guidance before browser-owned passkey UI */
	showEducation?: boolean;
	/** Keep the educational flow's success confirmation visible until the user continues. Requires showEducation. */
	showSuccessStep?: boolean;
	/** Button shown after a successful educational flow */
	successButtonText?: string;
	/** Called when an educational success screen replaces surrounding choices */
	onSuccessReady?: () => void;
	/** Return to the account-details step from the top-level educational view */
	onBack?: () => void;
}

const EMPTY_DATA: Record<string, unknown> = {};

type RegistrationState =
	| { status: "idle" }
	| { status: "loading"; message: string }
	| { status: "error"; message: string }
	| { status: "success"; result: unknown };

type PasskeyPreference = "client-device" | "hybrid" | "security-key";

interface PublicKeyCredentialCreationOptionsWithHints extends PublicKeyCredentialCreationOptions {
	hints?: PasskeyPreference[];
}

type CapabilityState =
	| { status: "checking" }
	| { status: "ready"; capabilities: PasskeyClientCapabilities };

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

interface PlatformCopy {
	name: string;
	unlock: string;
	storage: string;
	icon: React.ReactNode;
}

function usePlatformCopy(platform: PasskeyPlatform): PlatformCopy {
	const { t } = useLingui();
	switch (platform) {
		case "windows":
			return {
				name: t`the Windows passkey prompt`,
				unlock: t`Choose Windows Hello or another available credential manager, then confirm with your PIN, fingerprint, or face.`,
				storage: t`Windows will show which credential manager will save it before creating it.`,
				icon: <WindowsLogo className="h-5 w-5" />,
			};
		case "macos":
			return {
				name: t`the macOS passkey prompt`,
				unlock: t`Choose Touch ID or another available credential manager, then confirm with your fingerprint or Mac password.`,
				storage: t`Your credential manager, such as iCloud Keychain, saves it and may sync it to your other devices.`,
				icon: <Fingerprint className="h-5 w-5" />,
			};
		case "ios":
			return {
				name: t`your device's passkey prompt`,
				unlock: t`Confirm with Face ID, Touch ID, or your device passcode.`,
				storage: t`Your credential manager, such as iCloud Keychain, saves it and may sync it to your other devices.`,
				icon: <DeviceMobile className="h-5 w-5" />,
			};
		case "android":
			return {
				name: t`the Android passkey prompt`,
				unlock: t`Confirm with your fingerprint, face, or PIN.`,
				storage: t`Your credential manager, such as Google Password Manager, saves it and may sync it to your other devices.`,
				icon: <DeviceMobile className="h-5 w-5" />,
			};
		default:
			return {
				name: t`your device's passkey prompt`,
				unlock: t`Confirm using the secure prompt from your device or credential manager.`,
				storage: t`Your device's credential manager saves it and will show you where before creating it.`,
				icon: <ShieldCheck className="h-5 w-5" />,
			};
	}
}

function PasskeyIntroduction({ storage }: { storage: string }) {
	const { t } = useLingui();
	return (
		<div className="space-y-4">
			<div className="text-center">
				<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-kumo-brand/10 text-kumo-link">
					<Key className="h-7 w-7" />
				</div>
				<h3 className="text-lg font-semibold">
					{t`With a passkey, you don’t need to remember complex passwords`}
				</h3>
			</div>

			<div className="space-y-3 text-start">
				<div className="flex items-start gap-3">
					<div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-link">
						<Key className="h-4 w-4" />
					</div>
					<div>
						<h4 className="text-sm font-medium">{t`What is a passkey?`}</h4>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t`An encrypted digital key you unlock using your fingerprint, face, PIN, or device password.`}
						</p>
					</div>
				</div>

				<div className="flex items-start gap-3">
					<div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-link">
						<ShieldCheck className="h-4 w-4" />
					</div>
					<div>
						<h4 className="text-sm font-medium">{t`Where is it saved?`}</h4>
						<p className="mt-1 text-sm text-kumo-subtle">{storage}</p>
					</div>
				</div>
			</div>
		</div>
	);
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
	showEducation = false,
	showSuccessStep = false,
	successButtonText,
	onSuccessReady,
	onBack,
}: PasskeyRegistrationProps) {
	const { t } = useLingui();
	const resolvedButtonText = buttonText ?? t`Register Passkey`;
	const resolvedSuccessButtonText = successButtonText ?? t`Continue`;
	const [state, setState] = React.useState<RegistrationState>({
		status: "idle",
	});
	const [passkeyName, setPasskeyName] = React.useState("");
	const [preference, setPreference] = React.useState<PasskeyPreference | null>(null);
	const [showWindowsHelloHelp, setShowWindowsHelloHelp] = React.useState(false);
	const [recheckFailed, setRecheckFailed] = React.useState(false);
	const [capabilityState, setCapabilityState] = React.useState<CapabilityState>({
		status: "checking",
	});

	// Secure context (HTTPS or http://localhost) + PublicKeyCredential
	const isSupported = React.useMemo(() => isPasskeyEnvironmentUsable(), []);
	const platform = React.useMemo(() => detectPasskeyPlatform(), []);
	const platformCopy = usePlatformCopy(platform);
	const insecureContext = React.useMemo(
		() => typeof window !== "undefined" && !isWebAuthnSecureContext(),
		[],
	);

	const checkCapabilities = React.useCallback(async () => {
		setCapabilityState({ status: "checking" });
		const capabilities = await getPasskeyClientCapabilities();
		setCapabilityState({ status: "ready", capabilities });
		return capabilities;
	}, []);

	React.useEffect(() => {
		if (!showEducation || !isSupported) return;
		let active = true;
		void (async () => {
			const capabilities = await getPasskeyClientCapabilities();
			if (active) setCapabilityState({ status: "ready", capabilities });
		})();
		return () => {
			active = false;
		};
	}, [isSupported, showEducation]);

	const handleRegister = React.useCallback(
		async (selectedPreference?: PasskeyPreference) => {
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
				}>(optionsResponse, t`Failed to get registration options`);
				const { options } = optionsData;

				// Step 2: Create credential with browser
				setState({ status: "loading", message: t`Waiting for passkey...` });

				// Convert options to the format expected by the browser
				const publicKeyOptions: PublicKeyCredentialCreationOptionsWithHints = {
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
					hints: selectedPreference ? [selectedPreference] : options.hints,
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
						transports: attestationResponse.getTransports?.() as
							| AuthenticatorTransport[]
							| undefined,
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
					t`Failed to verify registration`,
				);

				setState({ status: "success", result });
				if (showSuccessStep) onSuccessReady?.();
				else onSuccess(result);
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
		},
		[
			isSupported,
			optionsEndpoint,
			verifyEndpoint,
			additionalData,
			passkeyName,
			onSuccess,
			onError,
			onSuccessReady,
			showSuccessStep,
			t,
		],
	);

	const handleCheckAgain = React.useCallback(async () => {
		setRecheckFailed(false);
		const capabilities = await checkCapabilities();
		if (capabilities.platformAuthenticator) {
			setShowWindowsHelloHelp(false);
			setPreference("client-device");
		} else {
			setRecheckFailed(true);
		}
	}, [checkCapabilities]);

	// Not usable (insecure origin vs missing API — browser hides WebAuthn the same way)
	if (!isSupported) {
		return (
			<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-4">
				<h3 className="font-medium text-kumo-danger">{t`Passkeys Not Available Here`}</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					{insecureContext ? (
						<InsecurePasskeyContextMessage />
					) : (
						<>
							{t`Your browser doesn't support passkeys. Please use a modern browser like Chrome, Safari, Firefox, or Edge.`}
						</>
					)}
				</p>
			</div>
		);
	}

	if (showEducation && capabilityState.status === "checking") {
		return (
			<div className="flex items-center justify-center gap-3 py-8 text-sm text-kumo-subtle">
				<Loader />
				{t`Checking this device for passkey support...`}
			</div>
		);
	}

	if (showEducation && showSuccessStep && state.status === "success") {
		return (
			<div className="space-y-5 text-center">
				<div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-kumo-success/10 text-kumo-success">
					<ShieldCheck className="h-7 w-7" />
				</div>
				<div>
					<h3 className="text-lg font-semibold">{t`Passkey created`}</h3>
					<p className="mt-2 text-sm text-kumo-subtle">
						{t`It is stored by the authenticator or credential manager you selected in the secure system prompt.`}
					</p>
				</div>
				<p className="rounded-lg bg-kumo-tint p-3 text-start text-sm text-kumo-subtle">
					{t`You can view, rename, or add more passkeys later in Security settings.`}
				</p>
				<Button
					type="button"
					className="w-full justify-center"
					onClick={() => onSuccess(state.result)}
				>
					{resolvedSuccessButtonText}
				</Button>
			</div>
		);
	}

	const capabilities = capabilityState.status === "ready" ? capabilityState.capabilities : null;
	const noPlatformAuthenticator = capabilities?.platformAuthenticator === false;

	if (showEducation && showWindowsHelloHelp) {
		return (
			<div className="space-y-5">
				<div className="text-center">
					<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-kumo-brand/10 text-kumo-link">
						<WindowsLogo className="h-7 w-7" />
					</div>
					<h3 className="text-lg font-semibold">{t`Set up Windows Hello`}</h3>
					<p className="mt-2 text-sm text-kumo-subtle">
						{t`In Windows Settings, open Accounts, then Sign-in options, and set up a PIN. Fingerprint and face recognition are optional.`}
					</p>
				</div>
				<LinkButton
					href="ms-settings:signinoptions"
					external
					icon={<WindowsLogo />}
					className="w-full justify-center"
				>
					{t`Open Windows settings`}
				</LinkButton>
				<Button
					type="button"
					variant="outline"
					className="w-full justify-center"
					loading={capabilityState.status === "checking"}
					onClick={() => void handleCheckAgain()}
				>
					{t`I've set it up — check again`}
				</Button>
				{recheckFailed && (
					<p className="rounded-lg bg-kumo-warning/10 p-3 text-sm text-kumo-warning">
						{t`Windows Hello still isn't available to this browser. You can try another device or a security key instead.`}
					</p>
				)}
				<Button
					type="button"
					variant="ghost"
					className="w-full justify-center"
					onClick={() => setShowWindowsHelloHelp(false)}
				>
					{t`Choose another option`}
				</Button>
			</div>
		);
	}

	if (showEducation && noPlatformAuthenticator && preference === null) {
		return (
			<div className="space-y-5">
				<PasskeyIntroduction
					storage={t`Choose a credential manager on this device, another device, or a security key.`}
				/>
				<div className="flex items-start gap-3 rounded-lg bg-kumo-warning/10 p-3 text-start">
					<Info className="mt-0.5 h-5 w-5 shrink-0 text-kumo-warning" />
					<div>
						<h4 className="text-sm font-medium text-kumo-warning">
							{platform === "windows"
								? t`No Windows Hello authenticator found`
								: t`No built-in passkey authenticator found`}
						</h4>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t`We checked before opening the browser's passkey prompt so you can choose what happens next.`}
						</p>
					</div>
				</div>

				<div className="space-y-3">
					{platform === "windows" && (
						<Button
							type="button"
							variant="outline"
							icon={<WindowsLogo />}
							className="w-full justify-start"
							onClick={() => setShowWindowsHelloHelp(true)}
						>
							{t`Set up Windows Hello`}
						</Button>
					)}
					{capabilities?.hybridTransport !== false && (
						<Button
							type="button"
							variant="outline"
							icon={<DeviceMobile />}
							className="w-full justify-start"
							onClick={() => setPreference("hybrid")}
						>
							{t`Use another device`}
						</Button>
					)}
					<Button
						type="button"
						variant="outline"
						icon={<Usb />}
						className="w-full justify-start"
						onClick={() => setPreference("security-key")}
					>
						{t`Use a security key`}
					</Button>
				</div>
				{onBack && (
					<Button type="button" variant="ghost" className="w-full justify-center" onClick={onBack}>
						{t`Back`}
					</Button>
				)}
			</div>
		);
	}

	if (showEducation && preference === "hybrid") {
		return (
			<div className="space-y-5">
				<PasskeyIntroduction
					storage={t`The credential manager on the phone or tablet you choose saves it. EmDash does not receive the passkey.`}
				/>
				<div>
					<h4 className="text-sm font-medium">{t`What happens next?`}</h4>
					<ol className="mt-3 space-y-2 ps-5 text-sm text-kumo-subtle">
						<li>{t`The browser will usually show a QR code.`}</li>
						<li>{t`Scan it with a nearby phone or tablet.`}</li>
						<li>{t`Approve with that device's face, fingerprint, PIN, or passcode.`}</li>
					</ol>
				</div>
				<div className="flex items-start gap-3 rounded-lg bg-kumo-tint p-3 text-start">
					<DeviceMobile className="mt-0.5 h-5 w-5 shrink-0 text-kumo-link" />
					<div>
						<h4 className="text-sm font-medium">{t`Next, the browser's passkey window will open`}</h4>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t`The browser controls the exact prompt and may offer another compatible method.`}
						</p>
					</div>
				</div>
				{state.status === "error" && (
					<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">
						{state.message}
					</div>
				)}
				<div className="flex gap-3">
					<Button type="button" variant="outline" onClick={() => setPreference(null)}>
						{t`Back`}
					</Button>
					<Button
						type="button"
						className="flex-1 justify-center"
						loading={state.status === "loading"}
						onClick={() => void handleRegister("hybrid")}
					>
						{t`Continue with another device`}
					</Button>
				</div>
			</div>
		);
	}

	if (showEducation && preference === "security-key") {
		return (
			<div className="space-y-5">
				<PasskeyIntroduction
					storage={t`The passkey is saved on your physical security key and can be used on compatible devices.`}
				/>
				<div className="flex items-start gap-3 rounded-lg bg-kumo-tint p-3 text-start">
					<Usb className="mt-0.5 h-5 w-5 shrink-0 text-kumo-link" />
					<div>
						<h4 className="text-sm font-medium">{t`Next, the browser's passkey window will open`}</h4>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t`Insert or tap your security key when the browser asks.`}
						</p>
					</div>
				</div>
				{state.status === "error" && (
					<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">
						{state.message}
					</div>
				)}
				<div className="flex gap-3">
					<Button type="button" variant="outline" onClick={() => setPreference(null)}>
						{t`Back`}
					</Button>
					<Button
						type="button"
						className="flex-1 justify-center"
						loading={state.status === "loading"}
						onClick={() => void handleRegister("security-key")}
					>
						{t`Continue with security key`}
					</Button>
				</div>
			</div>
		);
	}

	if (showEducation) {
		const selectedPreference =
			preference ?? (capabilities?.platformAuthenticator === true ? "client-device" : undefined);
		return (
			<div className="space-y-5">
				<PasskeyIntroduction storage={platformCopy.storage} />
				<div className="flex items-start gap-3 rounded-lg bg-kumo-tint p-3 text-start">
					<div className="mt-0.5 shrink-0 text-kumo-link">{platformCopy.icon}</div>
					<div>
						<h4 className="text-sm font-medium">{t`Next, ${platformCopy.name} will open`}</h4>
						<p className="mt-1 text-sm text-kumo-subtle">{platformCopy.unlock}</p>
					</div>
				</div>
				{state.status === "error" && (
					<div className="rounded-lg bg-kumo-danger/10 p-4 text-sm text-kumo-danger">
						{state.message}
					</div>
				)}
				<Button
					type="button"
					className="w-full justify-center"
					loading={state.status === "loading"}
					onClick={() => void handleRegister(selectedPreference)}
				>
					{t`Create passkey`}
				</Button>
				<p className="text-center text-xs text-kumo-subtle">
					{t`EmDash never receives your PIN, password, or biometric information.`}
				</p>
				{onBack && (
					<Button type="button" variant="ghost" className="w-full justify-center" onClick={onBack}>
						{t`Back`}
					</Button>
				)}
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
				<div className="rounded-lg bg-kumo-success/10 p-4 text-sm text-kumo-success">
					{t`Passkey registered successfully!`}
				</div>
			)}

			{/* Register button */}
			<Button
				type="button"
				onClick={() => void handleRegister()}
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
