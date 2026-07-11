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
	algorithm: number;
	counter: number;
	deviceType: DeviceType;
	backedUp: boolean;
	transports: AuthenticatorTransport[];
}

export type VerifiedRegistrationWithContext<Context> = VerifiedRegistration & {
	challengeContext: Context;
};

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

export type VerifiedAuthenticationWithContext<Context> = VerifiedAuthentication & {
	challengeContext: Context;
};

// ============================================================================
// Challenge storage
// ============================================================================

export interface ChallengeStore {
	set(challenge: string, data: ChallengeData): Promise<void>;
	get(challenge: string): Promise<ChallengeData | null>;
	delete(challenge: string): Promise<void>;
}

/** A store that removes and returns a challenge in one atomic operation. */
export interface AtomicChallengeStore extends ChallengeStore {
	consume(challenge: string): Promise<ChallengeData | null>;
}

export interface ChallengeData {
	type: "registration" | "authentication";
	userId?: string; // For registration, the user being registered
	expiresAt: number;
	/** Canonical output from `encodeChallengeContext`. */
	context?: string;
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
	/** Defaults to `preferred` for backwards compatibility. */
	userVerification?: "discouraged" | "preferred" | "required";
}
