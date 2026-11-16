import type { DeclaredAccess } from "@emdash-cms/plugin-types";
import { diffDeclaredAccess } from "@emdash-cms/plugin-types";
import type {
	CodeFindingCategory,
	FindingSeverity,
	NormalizedModerationFinding,
} from "@emdash-cms/registry-moderation";
import { parse, type Node } from "acorn";

import type { BundleAnomaly, BundleAnomalyCode, BundleFile, UnpackedBundle } from "./bundle.js";
import {
	compileRegex,
	type AccessCheck,
	type AccessDiffRule,
	type AstMatch,
	type AstRule,
	type CodeRule,
	type CodeRuleset,
	type TextRule,
} from "./ruleset.js";

export const CODE_ENGINE_VERSION = "code-assessment-engine-v1";
export const PACKAGE_EVIDENCE_PREFIX = "release.package:";

const MAX_FINDINGS = 32;
const MAX_EVIDENCE_PER_FINDING = 8;
const MAX_MATCHES_PER_FILE = 1_000;
const MAX_SUMMARY_LENGTH = 500;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^\[?[0-9a-f]*:[0-9a-f:]*:[0-9a-f.:]*\]?$/i;
const WILDCARD_LABEL_PREFIX_RE = /^\*\./;
const BROAD_WILDCARD_RE = /^\*(?:\.[^.]+)?$/;
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export type CodeEvidence =
	| { kind: "file"; file: string; start: number; end: number; line: number; column: number }
	| { kind: "entry"; entryIndex?: number }
	| { kind: "access"; path: string }
	| { kind: "previous-release"; version: string };

export interface CodeFinding {
	ruleId: string;
	category: CodeFindingCategory;
	severity: FindingSeverity;
	confidence: number;
	summary: string;
	evidence: readonly CodeEvidence[];
}

export interface PreviousReleaseAccess {
	version: string;
	declaredAccess: DeclaredAccess;
}

export interface CodeScanInput {
	ruleset: CodeRuleset;
	bundle: UnpackedBundle;
	declaredAccess: DeclaredAccess;
	/** `null` when the release is the package's first; required when the ruleset has diff rules. */
	previousRelease?: PreviousReleaseAccess | null;
}

export interface CodeScanResult {
	findings: readonly CodeFinding[];
	truncated: boolean;
}

export function rulesetNeedsPreviousRelease(ruleset: CodeRuleset): boolean {
	return ruleset.rules.some((rule) => rule.kind === "access-diff");
}

export function scanPackageCode(input: CodeScanInput): CodeScanResult {
	const findings: CodeFinding[] = [...anomalyFindings(input.bundle.anomalies)];
	const programs = new Map<string, Node | null>();
	const programFor = (file: BundleFile): Node | null => {
		if (!programs.has(file.path)) programs.set(file.path, parseJavaScript(file.text ?? ""));
		return programs.get(file.path) ?? null;
	};
	const unparseable = new Set<string>();
	for (const rule of input.ruleset.rules) {
		switch (rule.kind) {
			case "ast":
				for (const file of matchingFiles(input.bundle.files, rule.files)) {
					if (file.text === undefined) continue;
					const program = programFor(file);
					if (!program) {
						unparseable.add(file.path);
						continue;
					}
					pushFileFinding(findings, rule, file, matchAst(program, rule.match));
				}
				break;
			case "text":
				for (const file of matchingFiles(input.bundle.files, rule.files)) {
					if (file.text === undefined) continue;
					pushFileFinding(findings, rule, file, matchText(file.text, rule));
				}
				break;
			case "access":
				pushFinding(findings, rule, matchAccess(input.declaredAccess, rule.check));
				break;
			case "access-diff":
				pushFinding(findings, rule, matchAccessDiff(input, rule));
				break;
		}
	}
	for (const path of unparseable) {
		findings.push({
			ruleId: "bundle.unparseable-javascript",
			category: "package-integrity",
			severity: "medium",
			confidence: 1,
			summary:
				"A JavaScript file in the package could not be parsed, so code rules could not inspect it.",
			evidence: [{ kind: "file", file: path, start: 0, end: 0, line: 1, column: 0 }],
		});
	}
	const ranked = findings
		.map((finding, index) => ({ finding, index }))
		.toSorted(
			(left, right) =>
				SEVERITY_RANK[right.finding.severity] - SEVERITY_RANK[left.finding.severity] ||
				left.index - right.index,
		)
		.map(({ finding }) => finding);
	return { findings: ranked.slice(0, MAX_FINDINGS), truncated: ranked.length > MAX_FINDINGS };
}

export function toModerationFinding(
	finding: CodeFinding,
): NormalizedModerationFinding<CodeFindingCategory> {
	return {
		category: finding.category,
		recommendation: "review",
		confidence: finding.confidence,
		severity: finding.severity,
		summary: `${finding.ruleId}: ${finding.summary}`.slice(0, MAX_SUMMARY_LENGTH),
		evidenceRefs: [...new Set(finding.evidence.map(evidenceRef))],
	};
}

export function evidenceRef(evidence: CodeEvidence): string {
	switch (evidence.kind) {
		case "file":
			return `${PACKAGE_EVIDENCE_PREFIX}${evidence.file}#L${evidence.line}C${evidence.column}:${evidence.start}-${evidence.end}`;
		case "entry":
			return `${PACKAGE_EVIDENCE_PREFIX}entry[${evidence.entryIndex ?? "archive"}]`;
		case "access":
			return `release.declaredAccess.${evidence.path}`;
		case "previous-release":
			return `previous-release@${evidence.version}`.slice(0, 256);
	}
}

const ANOMALY_SEVERITY: Record<BundleAnomalyCode, CodeFinding["severity"]> = {
	"compressed-size-exceeded": "high",
	"decompressed-size-exceeded": "high",
	"invalid-gzip": "high",
	"malformed-archive": "high",
	"entry-count-exceeded": "high",
	"file-count-exceeded": "high",
	"file-size-exceeded": "high",
	symlink: "high",
	hardlink: "high",
	"unsupported-entry-type": "high",
	"path-traversal": "critical",
	"unsafe-path": "high",
	"duplicate-entry": "high",
	"unexpected-entry": "medium",
	"missing-required-entry": "medium",
	"invalid-text-encoding": "medium",
};

const ANOMALY_SUMMARY: Record<BundleAnomalyCode, string> = {
	"compressed-size-exceeded":
		"The compressed package exceeds the bundle size limit and was not scanned.",
	"decompressed-size-exceeded": "The decompressed package exceeds the bundle size limit.",
	"invalid-gzip": "The package is not valid gzip data.",
	"malformed-archive": "The package tar archive is malformed or truncated.",
	"entry-count-exceeded": "The package contains more archive entries than a bundle allows.",
	"file-count-exceeded": "The package contains more files than a bundle allows.",
	"file-size-exceeded": "A package file exceeds the bundle size limits and was not scanned.",
	symlink: "The package contains a symbolic link.",
	hardlink: "The package contains a hard link.",
	"unsupported-entry-type": "The package contains an archive entry type that bundles never use.",
	"path-traversal": "The package contains an absolute path or a path that escapes the bundle root.",
	"unsafe-path": "The package contains a malformed or unsafe entry path.",
	"duplicate-entry": "The package contains two entries with the same or ambiguous path.",
	"unexpected-entry": "The package contains an entry outside the expected bundle layout.",
	"missing-required-entry": "The package is missing a required bundle file.",
	"invalid-text-encoding": "A package text file is not valid UTF-8 and was not scanned.",
};

function anomalyFindings(anomalies: readonly BundleAnomaly[]): CodeFinding[] {
	const grouped = new Map<BundleAnomalyCode, BundleAnomaly[]>();
	for (const anomaly of anomalies) {
		grouped.set(anomaly.code, [...(grouped.get(anomaly.code) ?? []), anomaly]);
	}
	return Array.from(grouped, ([code, items]) => {
		const names = items.flatMap((item) => (item.name === undefined ? [] : [item.name]));
		return {
			ruleId: `bundle.${code}`,
			category: "package-integrity",
			severity: ANOMALY_SEVERITY[code],
			confidence: 1,
			summary:
				names.length === 0
					? ANOMALY_SUMMARY[code]
					: `${ANOMALY_SUMMARY[code]} Entries: ${names
							.slice(0, 4)
							.map((name) => JSON.stringify(name))
							.join(", ")}`,
			evidence: items
				.slice(0, MAX_EVIDENCE_PER_FINDING)
				.map((item) =>
					item.entryIndex === undefined
						? { kind: "entry" as const }
						: { kind: "entry" as const, entryIndex: item.entryIndex },
				),
		};
	});
}

function pushFileFinding(
	findings: CodeFinding[],
	rule: AstRule | TextRule,
	file: BundleFile,
	locations: readonly { start: number; end: number }[],
): void {
	if (locations.length === 0) return;
	const lines = lineStarts(file.text ?? "");
	pushFinding(
		findings,
		rule,
		locations.map(({ start, end }) => {
			const { line, column } = position(lines, start);
			return { kind: "file", file: file.path, start, end, line, column };
		}),
	);
}

function pushFinding(findings: CodeFinding[], rule: CodeRule, evidence: readonly CodeEvidence[]) {
	if (evidence.length === 0) return;
	findings.push({
		ruleId: rule.id,
		category: rule.category,
		severity: rule.severity,
		confidence: rule.confidence,
		summary: rule.summary,
		evidence: evidence.slice(0, MAX_EVIDENCE_PER_FINDING),
	});
}

function matchingFiles(files: readonly BundleFile[], patterns: readonly string[]): BundleFile[] {
	const expressions = patterns.map(globToRegExp);
	return files.filter((file) => expressions.some((expression) => expression.test(file.path)));
}

export function globToRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replaceAll(/[.+?^${}()|[\]\\/-]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${source}$`);
}

function parseJavaScript(source: string): Node | null {
	for (const sourceType of ["module", "script"] as const) {
		try {
			return parse(source, {
				ecmaVersion: "latest",
				sourceType,
				allowHashBang: true,
				allowAwaitOutsideFunction: sourceType === "script",
			});
		} catch {
			// Try the next source type.
		}
	}
	return null;
}

type AnyNode = Node & Record<string, unknown>;

function matchAst(program: Node, match: AstMatch): { start: number; end: number }[] {
	const found = new Map<number, { start: number; end: number }>();
	const record = (node: Node) => {
		if (found.size < MAX_MATCHES_PER_FILE)
			found.set(node.start, { start: node.start, end: node.end });
	};
	walk(program, (node, parent, key) => {
		switch (match.type) {
			case "identifier":
				if (
					node.type === "Identifier" &&
					match.names.includes(String(node["name"])) &&
					isReference(parent, key)
				) {
					record(node);
				}
				break;
			case "member":
				if (node.type === "MemberExpression" && expressionPath(node["object"]) === match.object) {
					if (memberNameMatches(match, staticPropertyName(node))) record(node);
				}
				if (
					node.type === "VariableDeclarator" &&
					expressionPath(node["init"]) === match.object &&
					isNode(node["id"]) &&
					node["id"].type === "ObjectPattern"
				) {
					for (const property of nodeArray(node["id"]["properties"])) {
						if (memberNameMatches(match, propertyKeyName(property))) record(property);
					}
				}
				break;
			case "call-object-key":
				if (
					(node.type === "CallExpression" || node.type === "NewExpression") &&
					expressionPath(node["callee"]) === match.callee
				) {
					const args = nodeArray(node["arguments"]);
					const candidates =
						match.argumentIndex === undefined
							? args
							: args.slice(match.argumentIndex, match.argumentIndex + 1);
					for (const argument of candidates) {
						if (argument.type !== "ObjectExpression") continue;
						for (const property of nodeArray(argument["properties"])) {
							const name = propertyKeyName(property);
							if (name !== null && match.keys.includes(name)) record(property);
						}
					}
				}
				break;
			case "import": {
				const specifier = importSpecifier(node);
				if (specifier && moduleMatches(specifier.value, match.modules)) record(specifier.node);
				break;
			}
		}
	});
	return [...found.values()].toSorted((left, right) => left.start - right.start);
}

function memberNameMatches(
	match: Extract<AstMatch, { type: "member" }>,
	name: string | null,
): boolean {
	if (name === null) return match.computed || match.properties === undefined;
	return match.properties ? match.properties.includes(name) : !match.computed;
}

function walk(
	root: Node,
	visit: (node: AnyNode, parent: AnyNode | null, key: string | null) => void,
): void {
	if (!isNode(root)) return;
	const stack: { node: AnyNode; parent: AnyNode | null; key: string | null }[] = [
		{ node: root, parent: null, key: null },
	];
	while (stack.length > 0) {
		const { node, parent, key } = stack.pop()!;
		visit(node, parent, key);
		for (const [childKey, value] of Object.entries(node)) {
			if (Array.isArray(value)) {
				for (let index = value.length - 1; index >= 0; index -= 1) {
					const child: unknown = value[index];
					if (isNode(child)) stack.push({ node: child, parent: node, key: childKey });
				}
			} else if (isNode(value)) {
				stack.push({ node: value, parent: node, key: childKey });
			}
		}
	}
}

function isNode(value: unknown): value is AnyNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		typeof (value as { start?: unknown }).start === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeArray(value: unknown): AnyNode[] {
	return Array.isArray(value) ? value.filter(isNode) : [];
}

function isReference(parent: AnyNode | null, key: string | null): boolean {
	if (!parent) return true;
	switch (parent.type) {
		case "MemberExpression":
			return key !== "property" || parent["computed"] === true;
		case "Property":
		case "MethodDefinition":
		case "PropertyDefinition":
			return key !== "key" || parent["computed"] === true;
		case "LabeledStatement":
		case "BreakStatement":
		case "ContinueStatement":
			return key !== "label";
		case "MetaProperty":
			return false;
		case "ExportSpecifier":
			return key !== "exported";
		case "ImportSpecifier":
			return key !== "imported";
		default:
			return true;
	}
}

function expressionPath(value: unknown): string | null {
	if (!isNode(value)) return null;
	switch (value.type) {
		case "Identifier":
			return String(value["name"]);
		case "ThisExpression":
			return "this";
		case "ChainExpression":
			return expressionPath(value["expression"]);
		case "MemberExpression": {
			const object = expressionPath(value["object"]);
			const property = staticPropertyName(value);
			return object === null || property === null ? null : `${object}.${property}`;
		}
		default:
			return null;
	}
}

function staticPropertyName(member: AnyNode): string | null {
	const property = member["property"];
	if (!isNode(property)) return null;
	if (member["computed"] !== true) {
		return property.type === "Identifier" || property.type === "PrivateIdentifier"
			? String(property["name"])
			: null;
	}
	return property.type === "Literal" && typeof property["value"] === "string"
		? property["value"]
		: null;
}

function propertyKeyName(property: AnyNode): string | null {
	if (property.type !== "Property") return null;
	const key = property["key"];
	if (!isNode(key)) return null;
	if (property["computed"] !== true && key.type === "Identifier") return String(key["name"]);
	return key.type === "Literal" &&
		(typeof key["value"] === "string" || typeof key["value"] === "number")
		? String(key["value"])
		: null;
}

function importSpecifier(node: AnyNode): { node: AnyNode; value: string } | null {
	let source: unknown;
	switch (node.type) {
		case "ImportDeclaration":
		case "ExportNamedDeclaration":
		case "ExportAllDeclaration":
		case "ImportExpression":
			source = node["source"];
			break;
		case "CallExpression": {
			const callee = node["callee"];
			if (isNode(callee) && callee.type === "Identifier" && callee["name"] === "require") {
				source = nodeArray(node["arguments"])[0];
			}
			break;
		}
		default:
			return null;
	}
	if (!isNode(source)) return null;
	if (source.type === "Literal" && typeof source["value"] === "string") {
		return { node: source, value: source["value"] };
	}
	if (source.type === "TemplateLiteral" && nodeArray(source["expressions"]).length === 0) {
		const quasi = nodeArray(source["quasis"])[0];
		const value = quasi?.["value"];
		const cooked = isRecord(value) ? value["cooked"] : undefined;
		if (typeof cooked === "string") return { node: source, value: cooked };
	}
	return null;
}

function moduleMatches(specifier: string, modules: readonly string[]): boolean {
	return modules.some((pattern) =>
		pattern.endsWith("*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern,
	);
}

function matchText(source: string, rule: TextRule): { start: number; end: number }[] {
	const expression = compileRegex(rule.pattern, rule.flags);
	const locations: { start: number; end: number }[] = [];
	for (let scanned = 0; scanned < MAX_MATCHES_PER_FILE; scanned += 1) {
		const match = expression.exec(source);
		if (!match) break;
		locations.push({ start: match.index, end: match.index + match[0].length });
		if (match[0].length === 0) expression.lastIndex += 1;
	}
	return locations;
}

function matchAccess(access: DeclaredAccess, check: AccessCheck): CodeEvidence[] {
	const request = access.network?.request;
	const hosts = request?.allowedHosts ?? [];
	const hostEvidence = (predicate: (host: string) => boolean): CodeEvidence[] =>
		hosts.flatMap((host, index) =>
			predicate(host)
				? [{ kind: "access" as const, path: `network.request.allowedHosts[${index}]` }]
				: [],
		);
	switch (check.type) {
		case "host-wildcard":
			return hostEvidence((host) => BROAD_WILDCARD_RE.test(host.trim()));
		case "host-ip-literal":
			return hostEvidence((host) => {
				const bare = host.trim().replace(WILDCARD_LABEL_PREFIX_RE, "");
				return IPV4_RE.test(bare) || IPV6_RE.test(bare);
			});
		case "host-pattern": {
			const expression = new RegExp(check.pattern, check.flags);
			return hostEvidence((host) => expression.test(host));
		}
		case "unrestricted-network":
			return request !== undefined && request.allowedHosts === undefined
				? [{ kind: "access", path: "network.request" }]
				: [];
		case "declared":
			return hasAccessPath(access, check.path)
				? [{ kind: "access", path: check.path.join(".") }]
				: [];
	}
}

function hasAccessPath(access: DeclaredAccess, path: readonly string[]): boolean {
	let current: unknown = access;
	for (const segment of path) {
		if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
		current = current[segment];
	}
	return true;
}

function matchAccessDiff(input: CodeScanInput, rule: AccessDiffRule): CodeEvidence[] {
	if (input.previousRelease === undefined) {
		throw new TypeError("access-diff rules require the previous release lookup");
	}
	if (input.previousRelease === null) return [];
	const changes = diffDeclaredAccess(input.previousRelease.declaredAccess, input.declaredAccess)
		.changes.filter((change) => !rule.escalationsOnly || change.escalation)
		.filter(
			(change) =>
				!rule.paths ||
				rule.paths.some((prefix) =>
					prefix.every((segment, index) => change.path[index] === segment),
				),
		);
	if (changes.length === 0) return [];
	return [
		{ kind: "previous-release", version: input.previousRelease.version },
		...changes.map((change) => ({ kind: "access" as const, path: change.path.join(".") })),
	];
}

function lineStarts(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index += 1) {
		if (source.charCodeAt(index) === 10) starts.push(index + 1);
	}
	return starts;
}

function position(starts: readonly number[], offset: number): { line: number; column: number } {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle]! <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low + 1, column: offset - starts[low]! };
}
