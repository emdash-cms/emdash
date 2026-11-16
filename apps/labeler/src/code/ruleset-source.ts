import { sha256Hex } from "../ai/hash.js";
import { CodeRulesetError, parseCodeRuleset, type CodeRuleset } from "./ruleset.js";

const MAX_RULESET_BYTES = 512 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const CACHE_KEY = Symbol.for("emdash.labeler.codeRulesetCache");

export interface LoadedCodeRuleset {
	ruleset: CodeRuleset;
	sha256: string;
}

export interface CodeRulesetSource {
	load(): Promise<LoadedCodeRuleset>;
}

export interface CodeRulesetObject {
	readonly size: number;
	readonly etag: string;
	text(): Promise<string>;
}

export interface CodeRulesetBucket {
	get(key: string): Promise<CodeRulesetObject | null>;
}

interface CachedRuleset {
	key: string;
	etag: string;
	loadedAt: number;
	value: LoadedCodeRuleset;
}

type RulesetCache = Map<string, CachedRuleset>;

export function createR2CodeRulesetSource(
	bucket: CodeRulesetBucket,
	key: string,
	now: () => number = Date.now,
): CodeRulesetSource {
	if (key.length === 0 || key.length > 512) throw new TypeError("code ruleset key is invalid");
	return {
		async load() {
			const cache = rulesetCache();
			const cached = cache.get(key);
			if (cached && now() - cached.loadedAt < CACHE_TTL_MS) return cached.value;
			const object = await bucket.get(key);
			if (!object) throw new CodeRulesetError("code ruleset object is missing");
			if (cached && cached.etag === object.etag) {
				cache.set(key, { ...cached, loadedAt: now() });
				return cached.value;
			}
			if (object.size > MAX_RULESET_BYTES) {
				throw new CodeRulesetError("code ruleset object exceeds its byte limit");
			}
			const value = await parseCodeRulesetText(await object.text());
			cache.set(key, { key, etag: object.etag, loadedAt: now(), value });
			return value;
		},
	};
}

export async function parseCodeRulesetText(source: string): Promise<LoadedCodeRuleset> {
	if (new TextEncoder().encode(source).byteLength > MAX_RULESET_BYTES) {
		throw new CodeRulesetError("code ruleset exceeds its byte limit");
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new CodeRulesetError("code ruleset is not valid JSON");
	}
	return { ruleset: parseCodeRuleset(value), sha256: await sha256Hex(source) };
}

export function clearCodeRulesetCache(): void {
	rulesetCache().clear();
}

function rulesetCache(): RulesetCache {
	const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: RulesetCache };
	holder[CACHE_KEY] ??= new Map();
	return holder[CACHE_KEY];
}
