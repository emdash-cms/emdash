import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const SEED_PATH = resolve(process.cwd(), "seed/seed.json");
const PRESETS_PATH = resolve(process.cwd(), "theme/presets.json");
const THEME_CONFIG_PATH = resolve(process.cwd(), "theme/theme.json");
const THEME_CSS_PATH = resolve(process.cwd(), "src/styles/theme.css");

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

function setOrDelete(settings, key, value) {
	const normalized = value.trim();
	if (normalized) {
		settings[key] = normalized;
		return;
	}
	delete settings[key];
}

function buildThemeCss(tokens) {
	return `:root {
\t--font-sans: ${tokens.fontSans};
\t--font-display: ${tokens.fontDisplay};
\t--bg: ${tokens.bg};
\t--surface: ${tokens.surface};
\t--text: ${tokens.text};
\t--muted: ${tokens.muted};
\t--brand: ${tokens.brand};
\t--brand-soft: ${tokens.brandSoft};
\t--border: ${tokens.border};
\t--radius: ${tokens.radius};
\t--shadow: ${tokens.shadow};
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

function loadPresets() {
	if (!existsSync(PRESETS_PATH)) {
		console.error(`Missing presets file: ${PRESETS_PATH}`);
		process.exit(1);
	}
	return JSON.parse(readFileSync(PRESETS_PATH, "utf8"));
}

async function main() {
	if (!existsSync(SEED_PATH)) {
		console.error(`Missing seed file: ${SEED_PATH}`);
		process.exit(1);
	}

	const presets = loadPresets();

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const ask = async (question, fallback = "") => {
		const suffix = fallback ? ` (${fallback})` : "";
		const answer = (await rl.question(`${question}${suffix}: `)).trim();
		return answer || fallback;
	};

	const businessName = await ask("Business name", "My Site");
	const tagline = await ask("Tagline", "Built with EmDash");
	const siteUrl = await ask("Site URL (https://example.com)");
	const phone = await ask("Phone");
	const email = await ask("Email");
	const address = await ask("Address");
	const locality = await ask("City / Locality");
	const region = await ask("State / Region");
	const postalCode = await ask("Postal Code");
	const country = await ask("Country");
	const latitudeInput = await ask("Latitude (optional)");
	const longitudeInput = await ask("Longitude (optional)");
	const hours = await ask("Business hours", "Mon-Fri 9:00 AM - 5:00 PM");
	const facebookUrl = await ask("Facebook URL");
	const instagramUrl = await ask("Instagram URL");
	const googleMapsUrl = await ask("Google Maps URL");

	console.log("\nChoose a design preset:");
	const presetKeys = Object.keys(presets);
	for (const key of presetKeys) {
		console.log(`- ${key}: ${presets[key].label}`);
	}
	const presetKeyInput = (await ask("Preset", "classic")).toLowerCase();
	const presetKey = presetKeys.includes(presetKeyInput) ? presetKeyInput : "classic";

	rl.close();

	const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
	seed.settings = seed.settings ?? {};
	seed.settings.title = businessName;
	seed.settings.tagline = tagline;
	setOrDelete(seed.settings, "url", siteUrl);
	setOrDelete(seed.settings, "phone", phone);
	setOrDelete(seed.settings, "email", email);
	setOrDelete(seed.settings, "address", address);
	setOrDelete(seed.settings, "locality", locality);
	setOrDelete(seed.settings, "region", region);
	setOrDelete(seed.settings, "postalCode", postalCode);
	setOrDelete(seed.settings, "country", country);
	setOrDelete(seed.settings, "hours", hours);
	setOrDelete(seed.settings, "facebookUrl", facebookUrl);
	setOrDelete(seed.settings, "instagramUrl", instagramUrl);
	setOrDelete(seed.settings, "googleMapsUrl", googleMapsUrl);
	if (latitudeInput.trim() && !Number.isNaN(Number(latitudeInput))) {
		seed.settings.latitude = Number(latitudeInput);
	} else {
		delete seed.settings.latitude;
	}
	if (longitudeInput.trim() && !Number.isNaN(Number(longitudeInput))) {
		seed.settings.longitude = Number(longitudeInput);
	} else {
		delete seed.settings.longitude;
	}

	const contactSummary = [
		phone ? `Phone: ${phone}` : "",
		email ? `Email: ${email}` : "",
		address ? `Address: ${address}` : "",
		hours ? `Hours: ${hours}` : "",
	]
		.filter(Boolean)
		.join(" | ");

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

	const hasContactData = Boolean(phone || email || address || hours || facebookUrl || instagramUrl || googleMapsUrl);

	if (hasContactData) {
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
						googleMapsUrl ? `Map: ${googleMapsUrl}` : "",
						facebookUrl ? `Facebook: ${facebookUrl}` : "",
						instagramUrl ? `Instagram: ${instagramUrl}` : "",
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

	const selectedPreset = presets[presetKey];
	ensureMenu(seed, hasContactData);

	writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, "\t")}\n`);
	writeFileSync(
		THEME_CONFIG_PATH,
		`${JSON.stringify({ preset: presetKey, tokens: selectedPreset.tokens }, null, "\t")}\n`,
	);
	writeFileSync(THEME_CSS_PATH, buildThemeCss(selectedPreset.tokens));

	console.log(`\nUpdated ${SEED_PATH}`);
	console.log(`Updated ${THEME_CONFIG_PATH}`);
	console.log(`Updated ${THEME_CSS_PATH}`);
	console.log("Run `pnpm bootstrap` next to initialize and seed the project.");
}

await main();
