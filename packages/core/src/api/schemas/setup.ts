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

export const atprotoLoginBody = z.object({
	handle: z.string().trim().min(1),
});

export const setupAtprotoAdminBody = z.object({
	handle: z.string().trim().min(1),
});
