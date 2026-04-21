import { z } from "zod";

import { httpUrl } from "./common.js";

// ---------------------------------------------------------------------------
// Settings: Input schemas
// ---------------------------------------------------------------------------

const mediaReference = z.object({
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

const seoSettings = z.object({
	titleSeparator: z.string().max(10).optional(),
	defaultOgImage: mediaReference.optional(),
	robotsTxt: z.string().max(5000).optional(),
	googleVerification: z.string().max(100).optional(),
	bingVerification: z.string().max(100).optional(),
});

const optionalHttpUrl = z.union([httpUrl, z.literal("")]).optional();
const optionalEmail = z.union([z.string().email(), z.literal("")]).optional();
const optionalPhone = z
	.string()
	.max(40)
	.regex(/^[\d+\-().\s]*$/, "Phone number contains invalid characters")
	.optional();
const optionalAddress = z.string().max(300).optional();
const optionalHours = z.string().max(500).optional();
const optionalLatitude = z.number().min(-90).max(90).optional();
const optionalLongitude = z.number().min(-180).max(180).optional();

export const settingsUpdateBody = z
	.object({
		title: z.string().optional(),
		tagline: z.string().optional(),
		logo: mediaReference.optional(),
		favicon: mediaReference.optional(),
		phone: optionalPhone,
		email: optionalEmail,
		address: optionalAddress,
		locality: z.string().max(120).optional(),
		region: z.string().max(120).optional(),
		postalCode: z.string().max(40).optional(),
		country: z.string().max(120).optional(),
		latitude: optionalLatitude,
		longitude: optionalLongitude,
		hours: optionalHours,
		facebookUrl: optionalHttpUrl,
		instagramUrl: optionalHttpUrl,
		googleMapsUrl: optionalHttpUrl,
		url: z.union([httpUrl, z.literal("")]).optional(),
		postsPerPage: z.number().int().min(1).max(100).optional(),
		dateFormat: z.string().optional(),
		timezone: z.string().optional(),
		social: socialSettings.optional(),
		seo: seoSettings.optional(),
	})
	.meta({ id: "SettingsUpdateBody" });

// ---------------------------------------------------------------------------
// Settings: Response schemas
// ---------------------------------------------------------------------------

export const siteSettingsSchema = z
	.object({
		title: z.string().optional(),
		tagline: z.string().optional(),
		logo: mediaReference.optional(),
		favicon: mediaReference.optional(),
		phone: z.string().optional(),
		email: z.string().optional(),
		address: z.string().optional(),
		locality: z.string().optional(),
		region: z.string().optional(),
		postalCode: z.string().optional(),
		country: z.string().optional(),
		latitude: z.number().optional(),
		longitude: z.number().optional(),
		hours: z.string().optional(),
		facebookUrl: z.string().optional(),
		instagramUrl: z.string().optional(),
		googleMapsUrl: z.string().optional(),
		url: z.string().optional(),
		postsPerPage: z.number().int().optional(),
		dateFormat: z.string().optional(),
		timezone: z.string().optional(),
		social: socialSettings.optional(),
		seo: seoSettings.optional(),
	})
	.meta({ id: "SiteSettings" });
