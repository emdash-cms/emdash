import { mkdirSync, writeFileSync } from "node:fs";

import { createLunaria } from "@lunariajs/core";

const lunaria = await createLunaria();
const status = await lunaria.getFullStatus();
const { sourceLocale, locales } = lunaria.config;
const links = lunaria.gitHostingLinks();

const fileStatus = status[0];
if (!fileStatus) {
	console.log("No tracked files found.");
	process.exit(0);
}

interface LocaleStatus {
	lang: string;
	label: string;
	totalKeys: number;
	completedKeys: number;
	missingKeys: string[];
	percentComplete: number;
	editUrl: string;
	historyUrl: string;
}

const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const QUOT = /"/g;

function countPoEntries(contents: string): number {
	let count = 0;
	for (const line of contents.split("\n")) {
		if (line.startsWith("msgid ") && line !== 'msgid ""') {
			count++;
		}
	}
	return count;
}

const totalKeys = countPoEntries(fileStatus.source.contents);

const localeStatuses: LocaleStatus[] = locales.map((locale) => {
	const localization = fileStatus.localizations.find((l) => l.lang === locale.lang);

	const missingKeys: string[] = [];
	if (localization && "missingKeys" in localization && localization.missingKeys) {
		for (const keyPath of localization.missingKeys) {
			missingKeys.push(Array.isArray(keyPath) ? keyPath.join(".") : String(keyPath));
		}
	}

	const completedKeys = totalKeys - missingKeys.length;
	const editUrl = localization
		? links.source(localization.path)
		: links.create(`packages/admin/src/locales/${locale.lang}/messages.po`);
	const historyUrl = localization ? links.history(localization.path) : "";

	return {
		lang: locale.lang,
		label: locale.label,
		totalKeys,
		completedKeys,
		missingKeys,
		percentComplete: totalKeys > 0 ? Math.round((completedKeys / totalKeys) * 100) : 100,
		editUrl,
		historyUrl,
	};
});

function barClass(percent: number): string {
	if (percent >= 100) return "completed";
	if (percent > 90) return "very-good";
	if (percent > 75) return "good";
	if (percent > 50) return "help-needed";
	return "basic";
}

function escapeHtml(s: string): string {
	return s.replace(AMP, "&amp;").replace(LT, "&lt;").replace(GT, "&gt;").replace(QUOT, "&quot;");
}

function localeCard(s: LocaleStatus): string {
	return `
<details class="locale">
	<summary>
		<strong>${s.label} <span class="lang">${s.lang}</span></strong>
		<span class="stats">${s.completedKeys}/${s.totalKeys} · ${s.percentComplete}%</span>
		<div class="bar"><div class="fill ${barClass(s.percentComplete)}" style="width:${s.percentComplete}%"></div></div>
	</summary>
	<div class="links">
		<a href="${s.editUrl}">Edit translation</a>
		${s.historyUrl ? `· <a href="${s.historyUrl}">History</a>` : ""}
	</div>
	${
		s.missingKeys.length > 0
			? `<details class="missing"><summary>${s.missingKeys.length} missing keys</summary><ul>${s.missingKeys.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul></details>`
			: `<p class="done">All strings translated 🎉</p>`
	}
</details>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EmDash Translation Status</title>
<meta name="description" content="Translation progress for the EmDash admin UI. See what needs translating and get involved.">
<link rel="canonical" href="https://i18n.emdashcms.com/">
<style>
*{box-sizing:border-box;margin:0}
:root{--bg:#fff;--fg:#111;--muted:#666;--border:#e5e5e5;--bar-bg:#eee}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--border:#333;--bar-bg:#222}}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);max-width:640px;margin:0 auto;padding:2rem 1rem;line-height:1.5}
h1{font-size:1.5rem;margin-bottom:.25rem}
.subtitle{color:var(--muted);margin-bottom:2rem}
a{color:inherit}
.locale{border:1px solid var(--border);border-radius:8px;margin-bottom:.75rem;padding:0}
.locale summary{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.75rem 1rem;cursor:pointer;list-style:none}
.locale summary::-webkit-details-marker{display:none}
.locale summary strong{flex:1}
.lang{font-weight:400;color:var(--muted);font-size:.875rem}
.stats{font-size:.875rem;color:var(--muted)}
.bar{width:100%;height:6px;background:var(--bar-bg);border-radius:3px;overflow:hidden;flex-basis:100%}
.fill{height:100%;border-radius:3px;transition:width .3s}
.completed{background:#22c55e}
.very-good{background:#84cc16}
.good{background:#f59e0b}
.help-needed{background:#ef4444}
.basic{background:#991b1b}
.links,.missing,.done{padding:.5rem 1rem .75rem}
.links{font-size:.875rem}
.links a{text-decoration:underline}
.missing summary{font-size:.875rem;cursor:pointer;color:var(--muted)}
.missing ul{margin-top:.5rem;padding-left:1.5rem;font-size:.8rem;font-family:ui-monospace,monospace}
.missing li{margin-bottom:.125rem}
.done{color:var(--muted);font-size:.875rem}
.footer{margin-top:2rem;font-size:.75rem;color:var(--muted)}
</style>
</head>
<body>
<h1>EmDash Translation Status</h1>
<p class="subtitle">Admin UI · ${totalKeys} translatable strings</p>
${localeStatuses.map(localeCard).join("\n")}
<p class="footer">Generated ${new Date().toISOString().split("T")[0]} · Powered by <a href="https://lunaria.dev">Lunaria</a></p>
</body>
</html>`;

const jsonStatus = {
	generatedAt: new Date().toISOString(),
	sourceLocale: { lang: sourceLocale.lang, label: sourceLocale.label, totalKeys },
	locales: localeStatuses,
};

mkdirSync("i18n/dist", { recursive: true });
writeFileSync("i18n/dist/index.html", html);
writeFileSync("i18n/dist/status.json", JSON.stringify(jsonStatus, null, "\t"));

console.log(`Generated dashboard: ${localeStatuses.length} locales, ${totalKeys} keys`);
for (const s of localeStatuses) {
	console.log(`  ${s.label} (${s.lang}): ${s.percentComplete}% — ${s.missingKeys.length} missing`);
}
