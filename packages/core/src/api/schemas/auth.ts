import { z } from "zod";

import { roleLevel } from "./common.js";

// ---------------------------------------------------------------------------
// WebAuthn credential schemas (matching @emdash-cms/auth/passkey types)
// ---------------------------------------------------------------------------

const authenticatorTransport = z.enum(["usb", "nfc", "ble", "internal", "hybrid"]);

/** RegistrationResponse — sent by the browser after navigator.credentials.create() */
const registrationCredential = z.object({
	id: z.string(),
	rawId: z.string(),
	type: z.literal("public-key"),
	response: z.object({
		clientDataJSON: z.string(),
		attestationObject: z.string(),
		transports: z.array(authenticatorTransport).optional(),
	}),
	authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});

/** AuthenticationResponse — sent by the browser after navigator.credentials.get() */
const authenticationCredential = z.object({
	id: z.string(),
	rawId: z.string(),
	type: z.literal("public-key"),
	response: z.object({
		clientDataJSON: z.string(),
		authenticatorData: z.string(),
		signature: z.string(),
		userHandle: z.string().optional(),
	}),
	authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});

// ---------------------------------------------------------------------------
// Auth: Input schemas
// ---------------------------------------------------------------------------

export const signupRequestBody = z
	.object({
		email: z.string().email(),
	})
	.meta({ id: "SignupRequestBody" });

export const signupCompleteBody = z
	.object({
		token: z.string().min(1),
		credential: registrationCredential,
		name: z.string().optional(),
	})
	.meta({ id: "SignupCompleteBody" });

export const inviteCreateBody = z
	.object({
		email: z.string().email(),
		role: roleLevel.optional(),
	})
	.meta({ id: "InviteCreateBody" });

export const inviteRegisterOptionsBody = z
	.object({
		token: z.string().min(1),
		name: z.string().optional(),
	})
	.meta({ id: "InviteRegisterOptionsBody" });

export const inviteCompleteBody = z
	.object({
		token: z.string().min(1),
		credential: registrationCredential,
		name: z.string().optional(),
	})
	.meta({ id: "InviteCompleteBody" });

export const magicLinkSendBody = z
	.object({
		email: z.string().email(),
	})
	.meta({ id: "MagicLinkSendBody" });

export const passkeyOptionsBody = z
	.object({
		email: z.string().email().optional(),
	})
	.meta({ id: "PasskeyOptionsBody" });

export const passkeyVerifyBody = z
	.object({
		credential: authenticationCredential,
	})
	.meta({ id: "PasskeyVerifyBody" });

export const passkeyRegisterOptionsBody = z
	.object({
		name: z.string().optional(),
	})
	.meta({ id: "PasskeyRegisterOptionsBody" });

export const passkeyRegisterVerifyBody = z
	.object({
		credential: registrationCredential,
		name: z.string().optional(),
	})
	.meta({ id: "PasskeyRegisterVerifyBody" });

export const passkeyRenameBody = z
	.object({
		name: z.string().min(1),
	})
	.meta({ id: "PasskeyRenameBody" });

export const authMeActionBody = z
	.object({
		action: z.string().min(1),
	})
	.meta({ id: "AuthMeActionBody" });
