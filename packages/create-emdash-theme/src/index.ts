#!/usr/bin/env node

/**
 * create-emdash-theme
 *
 * Scaffolds a new EmDash CMS theme (an Astro site with EmDash integration).
 *
 * Usage: npm create emdash-theme my-theme
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

const THEME_NAME_RE = /^[a-z][a-z0-9-]*$/;

async function main() {
	p.intro(pc.cyan("create-emdash-theme"));

	const args = process.argv.slice(2);
	let themeName = args[0];

	if (!themeName) {
		const result = await p.text({
			message: "Theme name:",
			placeholder: "my-awesome-theme",
			validate: (value) => {
				if (!value) return "Theme name is required";
				if (!THEME_NAME_RE.test(value)) return "Use lowercase letters, numbers, and hyphens";
				return undefined;
			},
		});

		if (p.isCancel(result)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		themeName = result;
	}

	const description = await p.text({
		message: "Description:",
		placeholder: `An EmDash theme for ${themeName}`,
	});

	if (p.isCancel(description)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const template = await p.select({
		message: "Base template:",
		options: [
			{ value: "blog", label: "Blog", hint: "Posts, categories, tags" },
			{ value: "marketing", label: "Marketing", hint: "Landing pages, pricing, contact" },
			{ value: "portfolio", label: "Portfolio", hint: "Projects, about, contact" },
		],
	});

	if (p.isCancel(template)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const dir = resolve(process.cwd(), themeName);

	if (existsSync(dir)) {
		p.cancel(`Directory "${themeName}" already exists.`);
		process.exit(1);
	}

	const s = p.spinner();
	s.start("Scaffolding theme...");

	// Create directory structure
	mkdirSync(join(dir, "src", "pages"), { recursive: true });
	mkdirSync(join(dir, "src", "layouts"), { recursive: true });
	mkdirSync(join(dir, "src", "styles"), { recursive: true });

	const desc = (description as string) || `An EmDash theme: ${themeName}`;

	// package.json
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: themeName,
				version: "0.1.0",
				description: desc,
				type: "module",
				scripts: {
					dev: "npx emdash dev",
					build: "astro build",
					preview: "astro preview",
				},
				dependencies: {
					astro: "^6.0.0",
					emdash: "*",
				},
				peerDependencies: {
					emdash: "*",
				},
			},
			null,
			"\t",
		) + "\n",
	);

	// src/pages/index.astro
	writeFileSync(join(dir, "src", "pages", "index.astro"), generateIndexPage(template as string));

	// src/layouts/Base.astro
	writeFileSync(join(dir, "src", "layouts", "Base.astro"), generateBaseLayout(themeName));

	// src/styles/theme.css
	writeFileSync(join(dir, "src", "styles", "theme.css"), generateThemeCSS());

	// live.config.ts
	writeFileSync(join(dir, "src", "live.config.ts"), generateLiveConfig());

	// README.md
	writeFileSync(join(dir, "README.md"), generateReadme(themeName, desc, template as string));

	s.stop("Theme scaffolded!");

	p.note(
		[
			`cd ${themeName}`,
			"npm install",
			"npx emdash dev",
			"",
			`Template: ${template}`,
			"Edit src/styles/theme.css to customize design tokens.",
		].join("\n"),
		"Next steps",
	);

	p.outro(pc.green("Happy building!"));
}

function generateIndexPage(template: string): string {
	if (template === "blog") {
		return `---
import Base from "../layouts/Base.astro";
import { getEmDashCollection } from "emdash";

const { entries: posts } = await getEmDashCollection("posts");
const sorted = posts.toSorted(
\t(a, b) => (b.data.publishedAt?.getTime() ?? 0) - (a.data.publishedAt?.getTime() ?? 0),
);
---

<Base title="Home">
\t<section class="hero">
\t\t<h1>Welcome to my blog</h1>
\t\t<p>Thoughts, stories, and ideas.</p>
\t</section>
\t<section class="posts">
\t\t{sorted.map((post) => (
\t\t\t<article class="post-card">
\t\t\t\t<a href={\`/posts/\${post.id}\`}>
\t\t\t\t\t<h2>{post.data.title}</h2>
\t\t\t\t</a>
\t\t\t\t{post.data.excerpt && <p>{post.data.excerpt}</p>}
\t\t\t</article>
\t\t))}
\t</section>
</Base>
`;
	}

	if (template === "marketing") {
		return `---
import Base from "../layouts/Base.astro";
---

<Base title="Home">
\t<section class="hero">
\t\t<h1>Your product, amplified</h1>
\t\t<p>A modern marketing site powered by EmDash.</p>
\t\t<a href="/contact" class="cta">Get Started</a>
\t</section>
\t<section class="features">
\t\t<div class="feature">
\t\t\t<h3>Fast</h3>
\t\t\t<p>Built on Astro for maximum performance.</p>
\t\t</div>
\t\t<div class="feature">
\t\t\t<h3>Flexible</h3>
\t\t\t<p>Customize every aspect of your site.</p>
\t\t</div>
\t\t<div class="feature">
\t\t\t<h3>Managed</h3>
\t\t\t<p>Content managed through EmDash CMS.</p>
\t\t</div>
\t</section>
</Base>
`;
	}

	// portfolio
	return `---
import Base from "../layouts/Base.astro";
---

<Base title="Home">
\t<section class="hero">
\t\t<h1>Hi, I'm [Your Name]</h1>
\t\t<p>Designer, developer, creator.</p>
\t</section>
\t<section class="work">
\t\t<h2>Selected Work</h2>
\t\t<p>Add your projects here.</p>
\t</section>
</Base>
`;
}

function generateBaseLayout(themeName: string): string {
	return `---
import "../styles/theme.css";

interface Props {
\ttitle: string;
\tdescription?: string;
}

const { title, description } = Astro.props;
const siteTitle = "${themeName}";
const fullTitle = \`\${title} — \${siteTitle}\`;
---

<!doctype html>
<html lang="en">
\t<head>
\t\t<meta charset="UTF-8" />
\t\t<meta name="viewport" content="width=device-width, initial-scale=1.0" />
\t\t<title>{fullTitle}</title>
\t\t{description && <meta name="description" content={description} />}
\t</head>
\t<body>
\t\t<header>
\t\t\t<nav>
\t\t\t\t<a href="/" class="site-title">{siteTitle}</a>
\t\t\t</nav>
\t\t</header>
\t\t<main>
\t\t\t<slot />
\t\t</main>
\t\t<footer>
\t\t\t<p>Powered by <a href="https://emdashcms.com">EmDash</a></p>
\t\t</footer>
\t</body>
</html>
`;
}

function generateThemeCSS(): string {
	return `/*
  theme.css — EmDash theme design tokens.

  Override any :root variable here to retheme the site.
  All values below use the EmDash design system defaults.
*/

:root {
\t/* --- Colors --- */
\t--color-bg: #ffffff;
\t--color-bg-subtle: #fafafa;
\t--color-text: #1a1a1a;
\t--color-text-secondary: #525252;
\t--color-muted: #8b8b8b;
\t--color-border: #e5e5e5;
\t--color-border-subtle: #f0f0f0;
\t--color-surface: #f7f7f7;
\t--color-accent: #E85D3A;
\t--color-accent-hover: #d14e2e;
\t--color-on-accent: white;

\t/* --- Fonts --- */
\t--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
\t--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

\t/* --- Type scale --- */
\t--font-size-sm: 0.875rem;
\t--font-size-base: 1rem;
\t--font-size-lg: 1.125rem;
\t--font-size-xl: 1.25rem;
\t--font-size-2xl: 1.5rem;
\t--font-size-3xl: 2rem;
\t--font-size-4xl: 2.5rem;

\t/* --- Line heights --- */
\t--leading-tight: 1.15;
\t--leading-normal: 1.5;
\t--leading-relaxed: 1.7;

\t/* --- Spacing --- */
\t--spacing-1: 0.25rem;
\t--spacing-2: 0.5rem;
\t--spacing-3: 0.75rem;
\t--spacing-4: 1rem;
\t--spacing-6: 1.5rem;
\t--spacing-8: 2rem;
\t--spacing-12: 3rem;
\t--spacing-16: 4rem;

\t/* --- Layout --- */
\t--content-width: 680px;
\t--wide-width: 1200px;

\t/* --- Borders & radius --- */
\t--radius: 4px;
\t--radius-lg: 8px;

\t/* --- Transitions --- */
\t--transition-fast: 120ms ease;
\t--transition-base: 180ms ease;
}

/* --- Dark mode --- */
@media (prefers-color-scheme: dark) {
\t:root {
\t\t--color-bg: #0d0d0d;
\t\t--color-bg-subtle: #141414;
\t\t--color-text: #ededed;
\t\t--color-text-secondary: #a0a0a0;
\t\t--color-muted: #6b6b6b;
\t\t--color-border: #2a2a2a;
\t\t--color-border-subtle: #1f1f1f;
\t\t--color-surface: #181818;
\t\t--color-accent: #f0795c;
\t\t--color-accent-hover: #f49178;
\t}
}

/* --- Base reset --- */
*,
*::before,
*::after {
\tbox-sizing: border-box;
}

body {
\tmargin: 0;
\tfont-family: var(--font-sans);
\tfont-size: var(--font-size-base);
\tline-height: var(--leading-relaxed);
\tcolor: var(--color-text);
\tbackground: var(--color-bg);
\t-webkit-font-smoothing: antialiased;
}

a {
\tcolor: var(--color-accent);
\ttext-decoration: none;
}

a:hover {
\tcolor: var(--color-accent-hover);
}

img {
\tmax-width: 100%;
\theight: auto;
\tdisplay: block;
}
`;
}

function generateLiveConfig(): string {
	return `/**
 * EmDash Live Content Collections
 *
 * Defines the _emdash collection that handles all content types from the database.
 * Query specific types using getEmDashCollection() and getEmDashEntry().
 */

import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
\t_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
`;
}

function generateReadme(name: string, desc: string, template: string): string {
	return `# ${name}

${desc}

## Getting Started

\`\`\`bash
npm install
npx emdash dev
\`\`\`

Open [http://localhost:4321](http://localhost:4321) to see your site.
The admin UI is at [http://localhost:4321/_emdash/admin](http://localhost:4321/_emdash/admin).

## Template

This theme was scaffolded with the **${template}** base template.

## Customization

Edit \`src/styles/theme.css\` to change design tokens (colors, fonts, spacing).

## Structure

\`\`\`
src/
\u251C\u2500\u2500 layouts/Base.astro    # HTML shell
\u251C\u2500\u2500 pages/index.astro     # Homepage
\u251C\u2500\u2500 styles/theme.css      # Design tokens
\u2514\u2500\u2500 live.config.ts        # EmDash content loader
\`\`\`

## Learn More

- [EmDash Documentation](https://emdashcms.com/docs)
- [Astro Documentation](https://docs.astro.build)
`;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
