import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const THEME_JSON_PATH = resolve(process.cwd(), "theme/theme.json");
const THEME_CSS_PATH = resolve(process.cwd(), "src/styles/theme.css");

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

function main() {
	if (!existsSync(THEME_JSON_PATH)) {
		console.error(`Missing theme config: ${THEME_JSON_PATH}`);
		process.exit(1);
	}

	const theme = JSON.parse(readFileSync(THEME_JSON_PATH, "utf8"));
	if (!theme?.tokens) {
		console.error("theme/theme.json must include a tokens object");
		process.exit(1);
	}

	writeFileSync(THEME_CSS_PATH, buildThemeCss(theme.tokens));
	console.log(`Updated ${THEME_CSS_PATH} from ${THEME_JSON_PATH}`);
}

main();
