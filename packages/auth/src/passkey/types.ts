/**
 * WebAuthn types for passkey authentication
 */

import type { AuthenticatorTransport, DeviceType } from "../types.js";

// ============================================================================
// Registration (Creating a new passkey)
// ============================================================================

export interface RegistrationOptions {
	challenge: string; // Base64url encoded
	rp: {
		name: string;
		id: string;
	};
	user: {
		id: string; // Base64url encoded user ID
		name: string;
		displayName: string;
	};
	pubKeyCredParams: Array<{
		type: "public-key";
		alg: number; // COSE algorithm identifier
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
		id: string; // Base64url encoded credential ID
		transports?: AuthenticatorTransport[];
	}>;
}

export interface RegistrationResponse {
	id: string; // Base64url credential ID
	rawId: string; // Base64url
	type: "public-key";
	response: {
		clientDataJSON: string; // Base64url
		attestationObject: string; // Base64url
		transports?: AuthenticatorTransport[];
	};
	authenticatorAttachment?: "platform" | "cross-platform";
}

export interface VerifiedRegistration {
	credentialId: string;
	publicKey: Uint8Array;
	counter: number;
	deviceType: DeviceType;
	backedUp: boolean;
	transports: AuthenticatorTransport[];
}

// ============================================================================
// Authentication (Using an existing passkey)
// ============================================================================

export interface AuthenticationOptions {
	challenge: string; // Base64url encoded
	rpId: string;
	timeout?: number;
	userVerification?: "discouraged" | "preferred" | "required";
	allowCredentials?: Array<{
		type: "public-key";
		id: string; // Base64url encoded credential ID
		transports?: AuthenticatorTransport[];
	}>;
}

export interface AuthenticationResponse {
	id: string; // Base64url credential ID
	rawId: string; // Base64url
	type: "public-key";
	response: {
		clientDataJSON: string; // Base64url
		authenticatorData: string; // Base64url
		signature: string; // Base64url
		userHandle?: string; // Base64url (user ID)
	};
	authenticatorAttachment?: "platform" | "cross-platform";
}

export interface VerifiedAuthentication {
	credentialId: string;
	newCounter: number;
}

// ============================================================================
// Challenge storage
// ============================================================================

export interface ChallengeStore {
	set(challenge: string, data: ChallengeData): Promise<void>;
	get(challenge: string): Promise<ChallengeData | null>;
	delete(challenge: string): Promise<void>;
}

export interface ChallengeData {
	type: "registration" | "authentication";
	userId?: string; // For registration, the user being registered
	expiresAt: number;
}

// ============================================================================
// Passkey Configuration
// ============================================================================

export interface PasskeyConfig {
	rpName: string;
	rpId: string;
	/**
	 * Accepted client-data origins. The first entry is the canonical/preferred
	 * origin; verification accepts any entry. Multiple entries support
	 * deployments where the same RP is reachable under several hostnames
	 * sharing `rpId` (e.g. apex + preview subdomain).
	 */
	origins: string[];
}
