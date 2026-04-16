/**
 * Passkey authentication module
 */

export type {
	RegistrationOptions,
	RegistrationResponse,
	VerifiedRegistration,
	AuthenticationOptions,
	AuthenticationResponse,
	VerifiedAuthentication,
	ChallengeStore,
	ChallengeData,
	PasskeyConfig,
} from "./types.js";

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
