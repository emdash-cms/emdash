/**
 * Structural validation of the options passed to `emdash()`.
 *
 * The schema checks the type and shape of each documented option so a wrong
 * value fails with its option path. Rules that need more than the shape (URL
 * policy, durations, plugin formats, locale lists, registry and migration
 * settings) stay with the helpers that already enforce them.
 */

import { z } from "zod";

import type { EmDashConfig } from "../astro/integration/runtime.js";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const descriptor = (what: string) =>
	z.custom<never>(
		(value) => isObject(value) && typeof value.entrypoint === "string",
		`Expected ${what} (an object with an \`entrypoint\`)`,
	);

const pluginDescriptor = z.custom<never>(
	(value) => isObject(value) && typeof value.id === "string",
	"Expected a plugin descriptor (an object with an `id`)",
);

const stringList = z.array(z.string());

const configShape = {
	database: descriptor("a database adapter such as sqlite() or d1()"),
	migrations: z.unknown(),
	storage: descriptor("a storage adapter such as local() or r2()"),
	objectCache: descriptor("an object cache adapter such as memoryCache() or kvCache()"),
	images: z.boolean(),
	imagePlaceholders: z.boolean(),
	plugins: z.array(pluginDescriptor),
	sandboxed: z.array(pluginDescriptor),
	sandboxRunner: z.string(),
	sandbox: z.boolean(),
	auth: descriptor("an auth adapter such as access()"),
	authProviders: z.array(
		z.custom<never>(
			(value) => isObject(value) && typeof value.id === "string",
			"Expected an auth provider (an object with an `id`)",
		),
	),
	mcp: z.boolean(),
	coEditing: z.boolean(),
	marketplace: z.string(),
	registry: z.unknown(),
	updateCheck: z.union(
		[z.boolean(), z.object({ minimumReleaseAge: z.union([z.string(), z.number()]).optional() })],
		{ error: "Expected a boolean or `{ minimumReleaseAge }`" },
	),
	maxUploadSize: z.number({ error: "Expected a number of bytes" }).positive(),
	siteUrl: z.string(),
	allowedOrigins: stringList,
	trustedProxyHeaders: stringList,
	middleware: z.unknown(),
	playground: z.object({ middlewareEntrypoint: z.string() }),
	mediaProviders: z.array(descriptor("a media provider")),
	fonts: z.union([z.literal(false), z.object({ scripts: stringList.optional() })], {
		error: "Expected `false` or `{ scripts: string[] }`",
	}),
	admin: z.object({
		logo: z.string().optional(),
		siteName: z.string().optional(),
		footerLabel: z
			.union([z.string(), z.literal(false)], { error: "Expected a string or `false`" })
			.optional(),
		favicon: z.string().optional(),
		locales: z.unknown().optional(),
		hiddenNavItems: z.unknown().optional(),
	}),
	toolbar: z.union([z.enum(["server", "client"]), z.literal(false)], {
		error: 'Expected "server", "client" or `false`',
	}),
	astroVersion: z.string(),
	robotsTxtOverridden: z.boolean(),
} satisfies { [K in keyof Required<EmDashConfig>]: z.ZodType };

const configSchema = z.looseObject(
	Object.fromEntries(Object.entries(configShape).map(([key, schema]) => [key, schema.optional()])),
);

const KNOWN_OPTIONS = Object.keys(configShape);

/**
 * Throw a readable error listing every option whose value has the wrong type
 * or shape. Returns the names of top-level options EmDash doesn't recognize.
 */
export function validateConfigShape(config: unknown): string[] {
	const result = configSchema.safeParse(config);
	if (!result.success) {
		throw new Error(`Invalid EmDash configuration:\n${z.prettifyError(result.error)}`);
	}
	return Object.keys(result.data).filter((key) => !KNOWN_OPTIONS.includes(key));
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		previous = current;
	}
	return previous[b.length];
}

/** Warning text for an unrecognized option, with the closest known name when one is near. */
export function unknownOptionWarning(key: string): string {
	const lower = key.toLowerCase();
	const closest = KNOWN_OPTIONS.map((name) => ({
		name,
		distance: editDistance(lower, name.toLowerCase()),
	})).toSorted((a, b) => a.distance - b.distance)[0];
	const hint = closest && closest.distance <= 2 ? ` Did you mean \`${closest.name}\`?` : "";
	return `Unknown EmDash config option \`${key}\` is ignored.${hint}`;
}
