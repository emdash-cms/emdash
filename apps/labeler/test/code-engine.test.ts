import type { DeclaredAccess } from "@emdash-cms/plugin-types";
import { describe, expect, it } from "vitest";

import type { UnpackedBundle } from "../src/code/bundle.js";
import { evidenceRef, scanPackageCode, toModerationFinding } from "../src/code/engine.js";
import { parseCodeRuleset, type CodeRuleset } from "../src/code/ruleset.js";
import { loadExampleRuleset } from "./code-fixtures.js";

function bundle(files: Record<string, string>): UnpackedBundle {
	return {
		files: Object.entries(files).map(([path, text], entryIndex) => ({
			path,
			entryIndex,
			byteLength: text.length,
			text,
		})),
		anomalies: [],
	};
}

function astRuleset(match: unknown): CodeRuleset {
	return parseCodeRuleset({
		schemaVersion: 1,
		rulesetId: "test",
		version: "1",
		rules: [
			{
				kind: "ast",
				id: "test-rule",
				category: "unsafe-code",
				severity: "medium",
				confidence: 0.5,
				summary: "Matched.",
				match,
			},
		],
	});
}

function lines(ruleset: CodeRuleset, source: string): number[] {
	const result = scanPackageCode({
		ruleset,
		bundle: bundle({ "backend.js": source }),
		declaredAccess: {},
	});
	return result.findings.flatMap(({ evidence }) =>
		evidence.flatMap((item) => (item.kind === "file" ? [item.line] : [])),
	);
}

describe("code rule engine", () => {
	it("reports eval references with file, line, column and offsets", async () => {
		const { ruleset } = await loadExampleRuleset();
		const source = "const run = (code) => {\n  return eval(code);\n};\n";
		const result = scanPackageCode({
			ruleset,
			bundle: bundle({ "backend.js": source, "admin.js": "new Function('x')" }),
			declaredAccess: {},
			previousRelease: null,
		});
		const finding = result.findings.find(({ ruleId }) => ruleId === "js-dynamic-evaluation");
		expect(finding).toMatchObject({ category: "unsafe-code", severity: "high", confidence: 0.7 });
		expect(finding?.evidence[0]).toEqual({
			kind: "file",
			file: "backend.js",
			start: source.indexOf("eval"),
			end: source.indexOf("eval") + 4,
			line: 2,
			column: 9,
		});
		expect(toModerationFinding(finding!)).toEqual({
			category: "unsafe-code",
			recommendation: "review",
			confidence: 0.7,
			severity: "high",
			summary: `js-dynamic-evaluation: ${finding!.summary}`,
			evidenceRefs: ["release.package:backend.js#L2C9:33-37"],
		});
		expect(result.findings.filter(({ ruleId }) => ruleId === "js-dynamic-evaluation")).toHaveLength(
			2,
		);
	});

	it("ignores identifiers that are property names, keys or labels", () => {
		const ruleset = astRuleset({ type: "identifier", names: ["target"] });
		expect(
			lines(
				ruleset,
				"obj.target();\nconst o = { target: 1 };\nclass A { target() {} }\ntarget: for (;;) break target;",
			),
		).toEqual([]);
		expect(lines(ruleset, "const o = { target };\nobj[target];")).toEqual([1, 2]);
	});

	it("matches property access on a base, including destructuring and computed names", () => {
		const fetchRule = astRuleset({ type: "member", object: "globalThis", properties: ["fetch"] });
		expect(
			lines(
				fetchRule,
				'globalThis.fetch(u);\nglobalThis["fetch"](u);\nconst { fetch } = globalThis;\nwindow.fetch(u);',
			),
		).toEqual([1, 2, 3]);
		const computedRule = astRuleset({ type: "member", object: "globalThis", computed: true });
		expect(
			lines(computedRule, "globalThis.fetch;\nglobalThis[name];\nglobalThis?.[name];"),
		).toEqual([2, 3]);
		const nested = astRuleset({ type: "member", object: "ctx.env" });
		expect(lines(nested, "ctx.env.SECRET;\nctx.other.SECRET;")).toEqual([1]);
	});

	it("matches object keys passed to a call", () => {
		const ruleset = astRuleset({
			type: "call-object-key",
			callee: "ctx.http.fetch",
			keys: ["headers"],
		});
		expect(
			lines(
				ruleset,
				'ctx.http.fetch(url, { method: "GET" });\nctx.http.fetch(url, {\n  "headers": {},\n});\nfetch(url, { headers: {} });',
			),
		).toEqual([3]);
		const indexed = astRuleset({
			type: "call-object-key",
			callee: "ctx.http.fetch",
			keys: ["headers"],
			argumentIndex: 0,
		});
		expect(lines(indexed, "ctx.http.fetch(url, { headers: {} });")).toEqual([]);
	});

	it("matches static, dynamic, re-exported and required imports", () => {
		const ruleset = astRuleset({ type: "import", modules: ["node:*", "fs"] });
		expect(
			lines(
				ruleset,
				'import a from "node:fs";\nexport * from "fs";\nconst b = await import(`node:os`);\nconst c = require("fs");\nimport d from "zod";',
			),
		).toEqual([1, 2, 3, 4]);
	});

	it("matches text rules only in the files they name", async () => {
		const { ruleset } = await loadExampleRuleset();
		const result = scanPackageCode({
			ruleset,
			bundle: bundle({
				"README.md": "# Plugin\n\n<IFRAME src=x></iframe>\n",
				"backend.js": "const html = '<script>';",
			}),
			declaredAccess: {},
			previousRelease: null,
		});
		const readme = result.findings.filter(({ ruleId }) => ruleId === "readme-raw-html");
		expect(readme).toHaveLength(1);
		expect(readme[0]?.evidence).toEqual([
			{ kind: "file", file: "README.md", start: 10, end: 17, line: 3, column: 0 },
		]);
	});

	it.each<[string, DeclaredAccess, string[]]>([
		[
			"a wildcard host",
			{ network: { request: { allowedHosts: ["api.example.com", "*"] } } },
			["access-wildcard-host"],
		],
		[
			"a TLD wildcard",
			{ network: { request: { allowedHosts: ["*.com"] } } },
			["access-wildcard-host"],
		],
		[
			"an IPv4 literal",
			{ network: { request: { allowedHosts: ["203.0.113.5"] } } },
			["access-ip-literal-host"],
		],
		[
			"an IPv6 literal",
			{ network: { request: { allowedHosts: ["[2001:db8::1]"] } } },
			["access-ip-literal-host"],
		],
		["unrestricted network access", { network: { request: {} } }, ["access-unrestricted-network"]],
		[
			"a scoped subdomain wildcard",
			{ network: { request: { allowedHosts: ["*.example.com"] } } },
			[],
		],
	])("checks manifest access for %s", async (_name, declaredAccess, expected) => {
		const { ruleset } = await loadExampleRuleset();
		const result = scanPackageCode({
			ruleset,
			bundle: bundle({ "backend.js": "" }),
			declaredAccess,
			previousRelease: null,
		});
		expect(result.findings.map(({ ruleId }) => ruleId)).toEqual(expected);
	});

	it("cites the allowedHosts entry that matched", async () => {
		const { ruleset } = await loadExampleRuleset();
		const [finding] = scanPackageCode({
			ruleset,
			bundle: bundle({}),
			declaredAccess: { network: { request: { allowedHosts: ["ok.example", "*"] } } },
			previousRelease: null,
		}).findings;
		expect(finding?.evidence.map(evidenceRef)).toEqual([
			"release.declaredAccess.network.request.allowedHosts[1]",
		]);
	});

	it("reports access escalations relative to the previous release", async () => {
		const { ruleset } = await loadExampleRuleset();
		const scan = (previous: DeclaredAccess | null, next: DeclaredAccess) =>
			scanPackageCode({
				ruleset,
				bundle: bundle({}),
				declaredAccess: next,
				previousRelease: previous === null ? null : { version: "1.2.2", declaredAccess: previous },
			}).findings.filter(({ ruleId }) => ruleId === "access-escalation");

		const escalated = scan(
			{ content: { read: {} }, network: { request: { allowedHosts: ["api.example.com"] } } },
			{
				content: { read: {}, write: {} },
				network: { request: { allowedHosts: ["api.example.com", "cdn.example.net"] } },
			},
		);
		expect(escalated).toHaveLength(1);
		expect(escalated[0]?.evidence.map(evidenceRef)).toEqual([
			"previous-release@1.2.2",
			"release.declaredAccess.content.write",
			"release.declaredAccess.network.request.allowedHosts",
		]);
		expect(scan({ content: { read: {}, write: {} } }, { content: { read: {} } })).toEqual([]);
		expect(scan(null, { content: { read: {}, write: {} } })).toEqual([]);
	});

	it("requires the previous release lookup when the ruleset has diff rules", async () => {
		const { ruleset } = await loadExampleRuleset();
		expect(() => scanPackageCode({ ruleset, bundle: bundle({}), declaredAccess: {} })).toThrow(
			/previous release lookup/,
		);
	});

	it("turns unparseable JavaScript and archive anomalies into findings", () => {
		const ruleset = astRuleset({ type: "identifier", names: ["eval"] });
		const result = scanPackageCode({
			ruleset,
			bundle: {
				...bundle({ "backend.js": "function (" }),
				anomalies: [
					{ code: "symlink", entryIndex: 2, name: "admin.js" },
					{ code: "path-traversal", entryIndex: 3, name: "../x" },
				],
			},
			declaredAccess: {},
		});
		expect(result.findings.map(({ ruleId, severity }) => [ruleId, severity])).toEqual([
			["bundle.path-traversal", "critical"],
			["bundle.symlink", "high"],
			["bundle.unparseable-javascript", "medium"],
		]);
		expect(result.findings[1]?.summary).toContain('"admin.js"');
		expect(result.findings[1]?.evidence.map(evidenceRef)).toEqual(["release.package:entry[2]"]);
	});

	it("keeps the most severe findings when a scan produces too many", () => {
		const ruleset = parseCodeRuleset({
			schemaVersion: 1,
			rulesetId: "many",
			version: "1",
			rules: Array.from({ length: 40 }, (_, index) => ({
				kind: "text",
				id: `rule-${index}`,
				category: "unsafe-code",
				severity: index === 39 ? "critical" : "low",
				confidence: 0.5,
				summary: "Matched.",
				pattern: "x",
			})),
		});
		const result = scanPackageCode({
			ruleset,
			bundle: bundle({ "backend.js": "x" }),
			declaredAccess: {},
		});
		expect(result.truncated).toBe(true);
		expect(result.findings).toHaveLength(32);
		expect(result.findings[0]?.ruleId).toBe("rule-39");
	});
});
