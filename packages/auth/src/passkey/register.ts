/**
 * Passkey registration (credential creation)
 *
 * Based on oslo webauthn documentation:
 * https://webauthn.oslojs.dev/examples/registration
 */

import { ECDSAPublicKey, p256 } from "@oslojs/crypto/ecdsa";
import { RSAPublicKey } from "@oslojs/crypto/rsa";
import { encodeBase64urlNoPadding, decodeBase64urlIgnorePadding } from "@oslojs/encoding";
import {
	parseAttestationObject,
	parseClientDataJSON,
	coseAlgorithmES256,
	coseAlgorithmRS256,
	coseEllipticCurveP256,
	ClientDataType,
	AttestationStatementFormat,
	COSEKeyType,
} from "@oslojs/webauthn";

import { generateToken } from "../tokens.js";
import type { Credential, NewCredential, AuthAdapter, User, DeviceType } from "../types.js";
import { PasskeyAuthenticationError } from "./authenticate.js";
import type {
	RegistrationOptions,
	RegistrationResponse,
	VerifiedRegistration,
	ChallengeStore,
	PasskeyConfig,
} from "./types.js";

const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

export type { PasskeyConfig };

/**
 * Generate registration options for creating a new passkey
 */
export async function generateRegistrationOptions(
	config: PasskeyConfig,
	user: Pick<User, "id" | "email" | "name">,
	existingCredentials: Credential[],
	challengeStore: ChallengeStore,
): Promise<RegistrationOptions> {
	const challenge = generateToken();

	// Store challenge for verification
	await challengeStore.set(challenge, {
		type: "registration",
		userId: user.id,
		expiresAt: Date.now() + CHALLENGE_TTL,
	});

	// Encode user ID as base64url
	const userIdBytes = new TextEncoder().encode(user.id);
	const userIdEncoded = encodeBase64urlNoPadding(userIdBytes);

	return {
		challenge,
		rp: {
			name: config.rpName,
			id: config.rpId,
		},
		user: {
			id: userIdEncoded,
			name: user.email,
			displayName: user.name || user.email,
		},
		pubKeyCredParams: [
			{ type: "public-key", alg: coseAlgorithmES256 }, // ES256 (-7)
			{ type: "public-key", alg: coseAlgorithmRS256 }, // RS256 (-257)
		],
		timeout: 60000,
		attestation: "none", // We don't need attestation for our use case
		authenticatorSelection: {
			residentKey: "preferred", // Allow discoverable credentials
			userVerification: "preferred",
		},
		excludeCredentials: existingCredentials.map((cred) => ({
			type: "public-key" as const,
			id: cred.id,
			transports: cred.transports,
		})),
	};
}

/**
 * Verify a registration response and extract credential data
 */
export async function verifyRegistrationResponse(
	config: PasskeyConfig,
	response: RegistrationResponse,
	challengeStore: ChallengeStore,
): Promise<VerifiedRegistration> {
	// Decode the response
	const clientDataJSON = decodeBase64urlIgnorePadding(response.response.clientDataJSON);
	const attestationObject = decodeBase64urlIgnorePadding(response.response.attestationObject);

	// Parse client data
	const clientData = parseClientDataJSON(clientDataJSON);

	// Verify client data
	if (clientData.type !== ClientDataType.Create) {
		throw new Error("Invalid client data type");
	}

	// Verify challenge - convert Uint8Array back to base64url string (no padding, matching stored format)
	const challengeString = encodeBase64urlNoPadding(clientData.challenge);
	const challengeData = await challengeStore.get(challengeString);
	if (!challengeData) {
		throw new Error("Challenge not found or expired");
	}
	if (challengeData.type !== "registration") {
		throw new Error("Invalid challenge type");
	}
	if (challengeData.expiresAt < Date.now()) {
		await challengeStore.delete(challengeString);
		throw new Error("Challenge expired");
	}

	// Delete challenge (single-use)
	await challengeStore.delete(challengeString);

	// Verify origin against the accepted list
	if (!config.origins.includes(clientData.origin)) {
		throw new Error(`Invalid origin: ${clientData.origin} not in [${config.origins.join(", ")}]`);
	}

	// Parse attestation object
	const attestation = parseAttestationObject(attestationObject);

	// We only support 'none' attestation for simplicity
	if (attestation.attestationStatement.format !== AttestationStatementFormat.None) {
		// For other formats, we'd need to verify the attestation statement
		// For now, we just ignore it and trust the credential
	}

	const { authenticatorData } = attestation;

	// Verify RP ID hash
	if (!authenticatorData.verifyRelyingPartyIdHash(config.rpId)) {
		throw new Error("Invalid RP ID hash");
	}

	// Verify flags
	if (!authenticatorData.userPresent) {
		throw new Error("User presence not verified");
	}

	// Extract credential data
	if (!authenticatorData.credential) {
		throw new Error("No credential data in attestation");
	}

	const { credential } = authenticatorData;

	// Verify algorithm is supported and encode public key
	// Supports ES256 (ECDSA P-256, stored as SEC1) and RS256 (RSA, stored as PKIX)
	const algorithm = credential.publicKey.algorithm();
	let encodedPublicKey: Uint8Array;

	if (algorithm === coseAlgorithmES256) {
		// Verify EC2 key type for ES256
		if (credential.publicKey.type() !== COSEKeyType.EC2) {
			throw new Error("Expected EC2 key type for ES256");
		}
		const cosePublicKey = credential.publicKey.ec2();
		if (cosePublicKey.curve !== coseEllipticCurveP256) {
			throw new Error("Expected P-256 curve for ES256");
		}
		// Encode as SEC1 uncompressed format for storage
		encodedPublicKey = new ECDSAPublicKey(
			p256,
			cosePublicKey.x,
			cosePublicKey.y,
		).encodeSEC1Uncompressed();
	} else if (algorithm === coseAlgorithmRS256) {
		// Verify RSA key type for RS256
		if (credential.publicKey.type() !== COSEKeyType.RSA) {
			throw new Error("Expected RSA key type for RS256");
		}
		const cosePublicKey = credential.publicKey.rsa();
		// Encode as PKIX format for storage
		encodedPublicKey = new RSAPublicKey(cosePublicKey.n, cosePublicKey.e).encodePKIX();
	} else {
		throw new PasskeyAuthenticationError(
			"unsupported_algorithm",
			"Unsupported credential algorithm",
		);
	}

	// Determine device type and backup status
	// Note: oslo webauthn doesn't expose backup flags, so we default to singleDevice
	// In practice, most modern passkeys are multi-device (e.g., iCloud Keychain, Google Password Manager)
	const deviceType: DeviceType = "singleDevice";
	const backedUp = false;

	return {
		credentialId: response.id,
		publicKey: encodedPublicKey,
		algorithm,
		counter: authenticatorData.signatureCounter,
		deviceType,
		backedUp,
		transports: response.response.transports ?? [],
	};
}

/**
 * Register a new passkey for a user
 */
export async function registerPasskey(
	adapter: AuthAdapter,
	userId: string,
	verified: VerifiedRegistration,
	name?: string,
): Promise<Credential> {
	// Check credential limit
	const count = await adapter.countCredentialsByUserId(userId);
	if (count >= 10) {
		throw new Error("Maximum number of passkeys reached (10)");
	}

	// Check if credential already exists
	const existing = await adapter.getCredentialById(verified.credentialId);
	if (existing) {
		throw new Error("Credential already registered");
	}

	const newCredential: NewCredential = {
		id: verified.credentialId,
		userId,
		publicKey: verified.publicKey,
		algorithm: verified.algorithm,
		counter: verified.counter,
		deviceType: verified.deviceType,
		backedUp: verified.backedUp,
		transports: verified.transports,
		name,
	};

	return adapter.createCredential(newCredential);
}
