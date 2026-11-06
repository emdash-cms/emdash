/**
 * Passkey authentication module
 */

export type {
	RegistrationOptions,
	RegistrationResponse,
	VerifiedRegistration,
	VerifiedRegistrationWithContext,
	AuthenticationOptions,
	AuthenticationResponse,
	VerifiedAuthentication,
	VerifiedAuthenticationWithContext,
	ChallengeStore,
	AtomicChallengeStore,
	ChallengeData,
	PasskeyConfig,
} from "./types.js";

export type {
	ChallengeContextBinding,
	ChallengeContextCodec,
	ChallengeContextErrorCode,
	SerializedChallengeContext,
} from "./challenge-context.js";
export {
	bindChallengeContext,
	ChallengeContextError,
	decodeChallengeContext,
	defineChallengeContext,
	encodeChallengeContext,
} from "./challenge-context.js";

export {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	registerPasskey,
} from "./register.js";

export type { PasskeyAuthenticationErrorCode } from "./authenticate.js";
export {
	PasskeyAuthenticationError,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	authenticateWithPasskey,
} from "./authenticate.js";
