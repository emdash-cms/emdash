import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const SEED_PATH = resolve(process.cwd(), "seed/seed.json");
const THEME_PATH = resolve(process.cwd(), "src/styles/theme.css");

const PRESETS = {
	classic: {
		label: "Classic Warm",
		fontSans: '"Instrument Sans", "Segoe UI", "Helvetica Neue", sans-serif',
		fontDisplay: '"Fraunces", Georgia, serif',
		bg: "#f5efe6",
		surface: "#fffaf2",
		text: "#1f1b16",
		muted: "#6c6255",
		brand: "#a14d2d",
		brandSoft: "#f5d2c4",
		border: "#d6c7b7",
		radius: "14px",
		shadow: "0 14px 34px rgba(43, 24, 12, 0.1)",
	},
	coastal: {
		label: "Coastal Fresh",
		fontSans: '"Plus Jakarta Sans", "Avenir Next", "Segoe UI", sans-serif',
		fontDisplay: '"Newsreader", "Times New Roman", serif',
		bg: "#edf7f8",
		surface: "#ffffff",
		text: "#0f2530",
		muted: "#4b6971",
		brand: "#126f86",
		brandSoft: "#cceaf1",
		border: "#b7dce5",
		radius: "18px",
		shadow: "0 12px 28px rgba(16, 77, 95, 0.14)",
	},
	orchard: {
		label: "Orchard Bold",
		fontSans: '"Outfit", "Segoe UI", "Helvetica Neue", sans-serif',
		fontDisplay: '"Bricolage Grotesque", "Trebuchet MS", sans-serif',
		bg: "#fff8ee",
		surface: "#ffffff",
		text: "#1f1a12",
		muted: "#655641",
		brand: "#cc5a15",
		brandSoft: "#ffd9bf",
		border: "#f2c9a8",
		radius: "12px",
		shadow: "0 12px 30px rgba(120, 52, 16, 0.16)",
	},
};

function askPortableText(text) {
	return [
		{
			_type: "block",
			style: "normal",
			children: [{ _type: "span", text }],
		},
	];
}

function getContentList(seed, slug) {
	if (!seed.content || typeof seed.content !== "object") {
		seed.content = {};
	}
	if (!Array.isArray(seed.content[slug])) {
		seed.content[slug] = [];
	}
	return seed.content[slug];
}

function upsertPage(seed, page) {
	const pages = getContentList(seed, "pages");
	const index = pages.findIndex((item) => item.id === page.id);
	if (index >= 0) {
		pages[index] = { ...pages[index], ...page, data: { ...pages[index].data, ...page.data } };
		return;
	}
	pages.push(page);
}

function ensureMenu(seed, includeContact) {
	if (!Array.isArray(seed.menus)) {
		seed.menus = [];
	}
	let primary = seed.menus.find((menu) => menu.name === "primary");
	if (!primary) {
		primary = { name: "primary", label: "Primary Navigation", items: [] };
		seed.menus.push(primary);
	}
	if (!Array.isArray(primary.items)) {
		primary.items = [];
	}
	const hasHome = primary.items.some((item) => item.url === "/");
	if (!hasHome) {
		primary.items.unshift({ type: "custom", label: "Home", url: "/" });
	}
	if (includeContact && !primary.items.some((item) => item.url === "/contact")) {
		primary.items.push({ type: "custom", label: "Contact", url: "/contact" });
	}
}

function buildThemeCss(preset) {
	return `:root {
\t--font-sans: ${preset.fontSans};
\t--font-display: ${preset.fontDisplay};
\t--bg: ${preset.bg};
\t--surface: ${preset.surface};
\t--text: ${preset.text};
\t--muted: ${preset.muted};
\t--brand: ${preset.brand};
\t--brand-soft: ${preset.brandSoft};
\t--border: ${preset.border};
\t--radius: ${preset.radius};
\t--shadow: ${preset.shadow};
}

* {
\tbox-sizing: border-box;
}

body {
\tmargin: 0;
\tfont-family: var(--font-sans);
\tline-height: 1.55;
\tcolor: var(--text);
\tbackground:
\t\tradial-gradient(circle at 10% -10%, var(--brand-soft), transparent 45%),
\t\tradial-gradient(circle at 80% 0%, rgba(255, 255, 255, 0.85), transparent 35%),
\t\tvar(--bg);
}

a {
\tcolor: var(--brand);
}

header,
main,
footer {
\tmax-width: 980px;
\tmargin: 0 auto;
\tpadding: 1rem 1.25rem;
}

header nav {
\tdisplay: flex;
\tflex-wrap: wrap;
\talign-items: center;
\tgap: 0.85rem;
\tpadding: 0.85rem 1rem;
\tborder: 1px solid var(--border);
\tborder-radius: var(--radius);
\tbackground: var(--surface);
\tbox-shadow: var(--shadow);
}

header nav a:first-child {
\tfont-family: var(--font-display);
\tfont-weight: 700;
\tfont-size: 1.2rem;
\ttext-decoration: none;
\tmargin-right: auto;
}

main {
\tpadding-top: 0.5rem;
}

article,
li {
\tbackground: var(--surface);
\tborder: 1px solid var(--border);
\tborder-radius: var(--radius);
\tpadding: 1rem;
\tbox-shadow: var(--shadow);
}

ul {
\tpadding: 0;
\tlist-style: none;
\tdisplay: grid;
\tgap: 1rem;
}

h1,
h2,
h3 {
\tfont-family: var(--font-display);
\tline-height: 1.2;
}

footer {
\tpadding-bottom: 3rem;
\tcolor: var(--muted);
}

@media (max-width: 700px) {
\theader,
\tmain,
\tfooter {
\t\tpadding-left: 0.8rem;
\t\tpadding-right: 0.8rem;
\t}

\theader nav {
\t\tgap: 0.6rem;
\t}
}
`;
}

async function main() {
	if (!existsSync(SEED_PATH)) {
		console.error(`Missing seed file: ${SEED_PATH}`);
		process.exit(1);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const ask = async (question, fallback = "") => {
		const suffix = fallback ? ` (${fallback})` : "";
		const answer = (await rl.question(`${question}${suffix}: `)).trim();
		return answer || fallback;
	};

	const businessName = await ask("Business name", "My Site");
	const tagline = await ask("Tagline", "Built with EmDash");
	const phone = await ask("Phone");
	const email = await ask("Email");
	const address = await ask("Address");
	const hours = await ask("Business hours", "Mon-Fri 9:00 AM - 5:00 PM");

	console.log("\nChoose a design preset:");
	const presetKeys = Object.keys(PRESETS);
	for (const key of presetKeys) {
		console.log(`- ${key}: ${PRESETS[key].label}`);
	}
	const presetKeyInput = (await ask("Preset", "classic")).toLowerCase();
	const presetKey = presetKeys.includes(presetKeyInput) ? presetKeyInput : "classic";

	rl.close();

	const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));	
	seed.settings = seed.settings ?? {};
	seed.settings.title = businessName;
	seed.settings.tagline = tagline;

	const contactSummary = [
		phone ? `Phone: ${phone}` : "",
		email ? `Email: ${email}` : "",
		address ? `Address: ${address}` : "",
		hours ? `Hours: ${hours}` : "",
	].filter(Boolean).join(" | ");

	upsertPage(seed, {
		id: "about",
		slug: "about",
		status: "published",
		data: {
			title: "About",
			content: askPortableText(
				`${businessName} is a local business website powered by EmDash. Replace this paragraph with your story.${contactSummary ? ` ${contactSummary}` : ""}`,
			),
		},
	});

	if (phone || email || address || hours) {
		upsertPage(seed, {
			id: "contact",
			slug: "contact",
			status: "published",
			data: {
				title: "Contact",
				content: askPortableText(
					[
						phone ? `Phone: ${phone}` : "",
						email ? `Email: ${email}` : "",
						address ? `Address: ${address}` : "",
						hours ? `Hours: ${hours}` : "",
					]
						.filter(Boolean)
						.join("\n"),
				),
			},
		});
	}

	const posts = getContentList(seed, "posts");
	if (posts.length > 0) {
		posts[0].data = posts[0].data ?? {};
		posts[0].data.title = `Welcome to ${businessName}`;
		posts[0].data.excerpt = `${businessName} is now live. Edit this post in the admin panel.`;
	}

	ensureMenu(seed, Boolean(phone || email || address || hours));

	writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, "\t")}\n`);
	writeFileSync(THEME_PATH, buildThemeCss(PRESETS[presetKey]));

	console.log(`\nUpdated ${SEED_PATH}`);
	console.log(`Updated ${THEME_PATH}`);
	console.log("Run `pnpm bootstrap` next to initialize and seed the project.");
}

await main();
