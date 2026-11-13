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
		email: z.email(),
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
		email: z.email(),
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
		email: z.email(),
	})
	.meta({ id: "MagicLinkSendBody" });

export const magicLinkVerifyBody = z
	.object({
		token: z.string().min(1),
	})
	.meta({ id: "MagicLinkVerifyBody" });

export const passkeyOptionsBody = z
	.object({
		email: z.email().optional().describe("Ignored. Accepted for compatibility with older clients."),
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

const ADMIN_LAYOUT_MAX_IDS = 200;
const ADMIN_LAYOUT_MAX_BYTES = 16 * 1024;

const LONE_SURROGATE = /\p{Cs}/u;

// PostgreSQL's jsonb rejects U+0000 and lone UTF-16 surrogates, so such an ID would fail the
// write instead of validation.
const adminLayoutId = z
	.string()
	.min(1)
	.refine((id) => !id.includes("\u0000") && !LONE_SURROGATE.test(id), {
		message: "IDs must not contain U+0000 or lone UTF-16 surrogates",
	});

const adminLayoutIds = z.array(adminLayoutId).max(ADMIN_LAYOUT_MAX_IDS);

const adminLayoutList = z.strictObject({
	order: adminLayoutIds,
	hidden: adminLayoutIds,
});

/**
 * A user's personal sidebar layout, stored at `users.data.adminLayout`.
 *
 * Validates both writes and reads, so a stored value this schema rejects is
 * served as `null`. The byte cap matters because the auth middleware parses
 * `users.data` on every authenticated request.
 */
export const adminLayoutSchema = z
	.strictObject({
		version: z.literal(1),
		nav: adminLayoutList,
		editor: adminLayoutList,
	})
	.refine(
		(layout) =>
			new TextEncoder().encode(JSON.stringify(layout)).byteLength <= ADMIN_LAYOUT_MAX_BYTES,
		{ message: "Admin layout must be 16 KB or smaller" },
	)
	.meta({ id: "AdminLayout" });

export type AdminLayout = z.infer<typeof adminLayoutSchema>;

/**
 * Envelope for `POST /auth/me`. The route dispatches on `action` and validates
 * the rest with that action's schema, so an unknown action answers
 * `UNKNOWN_ACTION` rather than a union `VALIDATION_ERROR`.
 */
export const authMeActionBody = z
	.looseObject({
		action: z.string().min(1),
	})
	.meta({ id: "AuthMeActionBody" });

/** `null` removes the stored layout. */
export const setAdminLayoutBody = z
	.strictObject({
		action: z.literal("setAdminLayout"),
		adminLayout: adminLayoutSchema.nullable(),
	})
	.meta({ id: "SetAdminLayoutBody" });
