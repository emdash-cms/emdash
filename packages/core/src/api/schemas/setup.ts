import { z } from "zod";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Registration credential — duplicated reference for setup flow.
 *  The canonical definition lives in auth.ts but setup needs it independently
 *  because setup runs before auth is configured. */
const authenticatorTransport = z.enum(["usb", "nfc", "ble", "internal", "hybrid"]);

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

export const setupBody = z.object({
	title: z.string().min(1),
	tagline: z.string().optional(),
	includeContent: z.boolean(),
});

export const setupAdminBody = z.object({
	email: z.string().email(),
	name: z.string().optional(),
});

export const setupAdminVerifyBody = z.object({
	credential: registrationCredential,
});

/**
 * Request body for POST /_emdash/api/setup/admin-totp — the client sends
 * the admin's email and name; the server generates a TOTP secret and
 * returns it along with a random challenge ID that identifies the
 * pending setup state.
 */
export const setupAdminTotpBody = z.object({
	email: z.string().email(),
	name: z.string().optional(),
});

/**
 * Request body for POST /_emdash/api/setup/admin-totp-verify — the
 * client echoes back the challengeId it received from the start route
 * plus the 6-digit code the user read from their authenticator app.
 * The code is validated as exactly 6 ASCII digits to fail early on
 * malformed input before any HMAC work runs.
 */
export const setupAdminTotpVerifyBody = z.object({
	challengeId: z.string().min(1),
	code: z.string().regex(/^\d{6}$/, "Code must be exactly 6 digits"),
});
