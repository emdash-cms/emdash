import { z } from "zod";

import { httpUrl } from "./common.js";

// ---------------------------------------------------------------------------
// Settings: Input schemas
//
// Media references on write are just `{ mediaId, alt? }` -- the resolved
// fields (`url`, `contentType`, `width`, `height`) are server-computed and
// stripped from any submitted body via Zod's default strip mode. See
// `packages/core/src/settings/types.ts` for the in-memory shape.
// ---------------------------------------------------------------------------

const mediaReferenceInput = z.object({
	mediaId: z.string(),
	alt: z.string().optional(),
});

const socialSettings = z.object({
	twitter: z.string().optional(),
	github: z.string().optional(),
	facebook: z.string().optional(),
	instagram: z.string().optional(),
	linkedin: z.string().optional(),
	youtube: z.string().optional(),
});

const seoSettingsInput = z.object({
	titleSeparator: z.string().max(10).optional(),
	defaultOgImage: mediaReferenceInput.optional(),
	robotsTxt: z.string().max(5000).optional(),
	googleVerification: z.string().max(100).optional(),
	bingVerification: z.string().max(100).optional(),
});

export const settingsUpdateBody = z
	.object({
		title: z.string().optional(),
		tagline: z.string().optional(),
		logo: mediaReferenceInput.optional(),
		favicon: mediaReferenceInput.optional(),
		url: z.union([httpUrl, z.literal("")]).optional(),
		postsPerPage: z.number().int().min(1).max(100).optional(),
		dateFormat: z.string().optional(),
		timezone: z.string().optional(),
		social: socialSettings.optional(),
		seo: seoSettingsInput.optional(),
	})
	.meta({ id: "SettingsUpdateBody" });

// ---------------------------------------------------------------------------
// Settings: Response schemas
//
// Responses carry the resolved fields populated by `resolveMediaReference`
// in `settings/index.ts`. Generated OpenAPI clients need to see them so
// they don't have to re-resolve the URL on the client. Fields stay
// optional because the resolver returns the bare ref if the underlying
// media row was deleted (orphaned reference).
// ---------------------------------------------------------------------------

const mediaReferenceResponse = z.object({
	mediaId: z.string(),
	alt: z.string().optional(),
	/** Resolved media file URL; absent if the underlying row is missing. */
	url: z.string().optional(),
	/** Stored MIME type (e.g. `image/svg+xml`). Populated alongside `url`. */
	contentType: z.string().optional(),
	/** Pixel width if known. Populated alongside `url`. */
	width: z.number().int().optional(),
	/** Pixel height if known. Populated alongside `url`. */
	height: z.number().int().optional(),
});

const seoSettingsResponse = z.object({
	titleSeparator: z.string().max(10).optional(),
	defaultOgImage: mediaReferenceResponse.optional(),
	robotsTxt: z.string().max(5000).optional(),
	googleVerification: z.string().max(100).optional(),
	bingVerification: z.string().max(100).optional(),
});

export const siteSettingsSchema = z
	.object({
		title: z.string().optional(),
		tagline: z.string().optional(),
		logo: mediaReferenceResponse.optional(),
		favicon: mediaReferenceResponse.optional(),
		url: z.string().optional(),
		postsPerPage: z.number().int().optional(),
		dateFormat: z.string().optional(),
		timezone: z.string().optional(),
		social: socialSettings.optional(),
		seo: seoSettingsResponse.optional(),
	})
	.meta({ id: "SiteSettings" });
