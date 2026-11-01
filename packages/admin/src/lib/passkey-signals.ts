/**
 * WebAuthn Signal API calls that keep the user's credential manager in step
 * with the server. Every signal is best effort: browsers without the API, or
 * credential managers that reject a signal, leave the calling flow unaffected.
 */

import { isPasskeyEnvironmentUsable } from "./webauthn-environment.js";

type SignalMethod =
	| "signalUnknownCredential"
	| "signalAllAcceptedCredentials"
	| "signalCurrentUserDetails";

function sendSignal(method: SignalMethod, options: Record<string, unknown>): void {
	if (!isPasskeyEnvironmentUsable()) return;
	const signal: unknown = Reflect.get(window.PublicKeyCredential, method);
	if (typeof signal !== "function") return;
	try {
		const result: unknown = Reflect.apply(signal, window.PublicKeyCredential, [options]);
		if (result instanceof Promise) result.catch(() => undefined);
	} catch {
		// Signals are advisory; a synchronous rejection changes nothing for the user.
	}
}

/** Ask the credential manager to remove a passkey the server no longer recognizes. */
export function signalUnknownPasskey(rpId: string, credentialId: string): void {
	sendSignal("signalUnknownCredential", { rpId, credentialId });
}

/**
 * Report the complete set of the user's registered passkeys so the credential
 * manager hides any others. Never call with a partial list: omitted passkeys
 * are removed from the user's device.
 */
export function signalAcceptedPasskeys(
	rpId: string,
	userHandle: string,
	credentialIds: string[],
): void {
	sendSignal("signalAllAcceptedCredentials", {
		rpId,
		userId: userHandle,
		allAcceptedCredentialIds: credentialIds,
	});
}

/** Update the account name and display name the credential manager shows for the user's passkeys. */
export function signalPasskeyUserDetails(
	rpId: string,
	userHandle: string,
	name: string,
	displayName: string,
): void {
	sendSignal("signalCurrentUserDetails", { rpId, userId: userHandle, name, displayName });
}
