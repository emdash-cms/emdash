import { type Platform, type TemplateKey, isTemplateKey } from "./flags.js";

/**
 * Where templates come from.
 *
 * The built-in template list maps to directories in the default templates
 * repo, but both halves are overridable:
 *
 * - `EMDASH_TEMPLATES_REPO` ("owner/name") replaces the default repo, so a
 *   fork can ship its own templates without forking the CLI.
 * - A `--template` value that isn't a built-in key is treated as a literal
 *   repo-relative directory name and downloaded as-is (no platform suffix),
 *   so ad-hoc templates work without being added to the built-in list.
 */

export const GITHUB_REPO = "emdash-cms/templates";

export interface TemplateConfig {
	name: string;
	description: string;
	/** Directory name in the templates repo */
	dir: string;
}

export const NODE_TEMPLATES = {
	blog: {
		name: "Blog",
		description: "A blog with posts, pages, and authors",
		dir: "blog",
	},
	starter: {
		name: "Starter",
		description: "A general-purpose starter with posts and pages",
		dir: "starter",
	},
	marketing: {
		name: "Marketing",
		description: "A marketing site with landing pages and CTAs",
		dir: "marketing",
	},
	portfolio: {
		name: "Portfolio",
		description: "A portfolio site with projects and case studies",
		dir: "portfolio",
	},
} as const satisfies Record<TemplateKey, TemplateConfig>;

export const CLOUDFLARE_TEMPLATES = {
	blog: {
		name: "Blog",
		description: "A blog with posts, pages, and authors",
		dir: "blog-cloudflare",
	},
	starter: {
		name: "Starter",
		description: "A general-purpose starter with posts and pages",
		dir: "starter-cloudflare",
	},
	marketing: {
		name: "Marketing",
		description: "A marketing site with landing pages and CTAs",
		dir: "marketing-cloudflare",
	},
	portfolio: {
		name: "Portfolio",
		description: "A portfolio site with projects and case studies",
		dir: "portfolio-cloudflare",
	},
} as const satisfies Record<TemplateKey, TemplateConfig>;

export interface TemplateSource {
	/** GitHub repo ("owner/name") the template dir is downloaded from. */
	repo: string;
	/** Repo-relative directory passed to giget. */
	dir: string;
	/** Human-readable label used for the emdash seed config. */
	name: string;
}

export function getTemplateConfig(platform: Platform, key: TemplateKey): TemplateConfig {
	return platform === "node" ? NODE_TEMPLATES[key] : CLOUDFLARE_TEMPLATES[key];
}

/**
 * Resolve the giget source for a template key.
 *
 * Pure: takes the platform and an env snapshot so it can be unit-tested
 * without touching `process.env` or the network.
 */
export function resolveTemplateSource(
	templateKey: string,
	platform: Platform,
	env: NodeJS.ProcessEnv = process.env,
): TemplateSource {
	// An empty override would produce a bogus `github:/<dir>` specifier.
	const repo = env.EMDASH_TEMPLATES_REPO || GITHUB_REPO;

	if (isTemplateKey(templateKey)) {
		const config = getTemplateConfig(platform, templateKey);
		return { repo, dir: config.dir, name: config.name };
	}

	// Ad-hoc template: the key IS the repo-relative directory. The platform
	// suffix rule only applies to built-in keys.
	return { repo, dir: templateKey, name: templateKey };
}
