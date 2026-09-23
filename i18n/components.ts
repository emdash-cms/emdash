import { posix } from "node:path";

import { html, type LunariaConfig, type LunariaStatus } from "@lunariajs/core";
import { getLocalization, getMissingKeys } from "@lunariajs/core/dashboard";

interface LocaleStatus {
	lang: string;
	label: string;
	completedKeys: number;
	missingKeys: string[];
	percentComplete: number;
	editUrl: string;
	historyUrl: string;
}

const LINE_BREAK = /\r?\n/;
const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const QUOT = /"/g;

/** Counts the entries of a gettext catalog, skipping the header entry. */
function countPoEntries(contents: string): number {
	const lines = contents.split(LINE_BREAK);
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.startsWith("msgid ")) continue;
		// Multi-line msgids start with `msgid ""` followed by continuation lines.
		if (line === 'msgid ""' && !lines[i + 1]?.startsWith('"')) continue;
		count++;
	}
	return count;
}

function githubLinks({ name, branch, rootDir }: LunariaConfig["repository"]) {
	const base = `https://github.com/${name}`;
	const inRepo = (path: string) => posix.join(rootDir, path);
	return {
		source: (path: string) => `${base}/blob/${branch}/${inRepo(path)}`,
		history: (path: string) => `${base}/commits/${branch}/${inRepo(path)}`,
		create: (path: string) => `${base}/new/${branch}?filename=${inRepo(path)}`,
	};
}

/** Per-locale progress of the single tracked catalog, counting translated keys instead of files. */
function getLocaleStatuses(config: LunariaConfig, status: LunariaStatus) {
	const entry = status[0];
	if (!entry) return { totalKeys: 0, locales: [] };

	const links = githubLinks(config.repository);
	const totalKeys = countPoEntries(entry.source.contents);

	const locales = config.locales.map((locale): LocaleStatus => {
		const localization = getLocalization(entry, locale.lang);
		if (!localization) {
			throw new Error(`Lunaria returned no status for locale "${locale.lang}"`);
		}

		const isMissing = localization.status === "missing";
		const missingKeys = getMissingKeys(localization);
		const completedKeys = isMissing ? 0 : totalKeys - missingKeys.length;

		return {
			lang: locale.lang,
			label: locale.label,
			completedKeys,
			missingKeys,
			percentComplete: totalKeys > 0 ? Math.round((completedKeys / totalKeys) * 100) : 100,
			editUrl: isMissing ? links.create(localization.path) : links.source(localization.path),
			historyUrl: isMissing ? "" : links.history(localization.path),
		};
	});

	return { totalKeys, locales };
}

function escapeHtml(s: string): string {
	return s.replace(AMP, "&amp;").replace(LT, "&lt;").replace(GT, "&gt;").replace(QUOT, "&quot;");
}

function barClass(percent: number): string {
	if (percent >= 100) return "completed";
	if (percent > 90) return "very-good";
	if (percent > 75) return "good";
	if (percent > 50) return "help-needed";
	return "basic";
}

const MissingKeys = (keys: string[]) =>
	keys.length > 0
		? html`<details class="missing">
				<summary>${keys.length.toString()} missing keys</summary>
				<ul>
					${keys.map((key) => html`<li>${escapeHtml(key)}</li>`)}
				</ul>
			</details>`
		: html`<p class="done">All strings translated 🎉</p>`;

const LocaleCard = (s: LocaleStatus, totalKeys: number) => html`
	<details class="locale">
		<summary>
			<strong>${s.label} <span class="lang">${s.lang}</span></strong>
			<span class="stats"
				>${s.completedKeys.toString()}/${totalKeys.toString()} ·
				${s.percentComplete.toString()}%</span
			>
			<div class="bar">
				<div
					class="fill ${barClass(s.percentComplete)}"
					style="width:${s.percentComplete.toString()}%"
				></div>
			</div>
		</summary>
		<div class="links">
			<a href="${s.editUrl}">Edit translation</a>
			${s.historyUrl ? html`· <a href="${s.historyUrl}">History</a>` : ""}
		</div>
		${MissingKeys(s.missingKeys)}
	</details>
`;

/** Replaces Lunaria's per-file locale progress with per-key progress of the admin catalog. */
export const StatusByLocale = (config: LunariaConfig, status: LunariaStatus) => {
	const { totalKeys, locales } = getLocaleStatuses(config, status);
	return html`
		<p class="subtitle">Admin UI · ${totalKeys.toString()} translatable strings</p>
		${locales.map((locale) => LocaleCard(locale, totalKeys))}
	`;
};

/** A single tracked file makes the per-file table redundant. */
export const StatusByFile = () => "";

export const Footer = () =>
	html`<p class="footer">
		Generated ${new Date().toISOString().split("T")[0] ?? ""} · Powered by
		<a href="https://lunaria.dev">Lunaria</a>
	</p>`;
