/**
 * Redirect loop and chain detection utilities.
 *
 * Builds a directed graph from redirect rules and detects:
 * - Cycles (loops): /a → /b → /c → /a
 * - Long chains: /a → /b → /c → /d → /e (exceeding a warning threshold)
 *
 * Handles both exact and pattern redirects. When the walker encounters
 * a path with no exact source match, it tests against compiled pattern
 * sources and resolves the destination using captured parameters.
 */

import {
	compilePattern,
	matchPattern,
	interpolateDestination,
	isPattern,
	normalizeSourcePath,
	validatePattern,
	type CompiledPattern,
} from "./patterns.js";

export interface RedirectEdge {
	id: string;
	source: string;
	destination: string;
	enabled: boolean;
	isPattern: boolean;
}

interface CompiledPatternRedirect {
	id: string;
	compiled: CompiledPattern;
	destination: string;
}

/**
 * Compile all enabled pattern redirects for matching during graph walks.
 */
function compilePatterns(edges: RedirectEdge[]): CompiledPatternRedirect[] {
	const result: CompiledPatternRedirect[] = [];
	for (const edge of edges) {
		if (edge.enabled && edge.isPattern && validatePattern(edge.source) === null) {
			result.push({
				id: edge.id,
				compiled: compilePattern(edge.source),
				destination: edge.destination,
			});
		}
	}
	return result;
}

/** Single-segment dummy value for representative path generation */
const DUMMY_SEGMENT = "__p__";

/** Splat pattern: [...paramName] */
const SPLAT_RE = /\[\.\.\.(\w+)\]/g;

/** Param pattern: [paramName] */
const PARAM_RE = /\[(\w+)\]/g;

/** Paths the redirect middleware matches against exact rules only */
const FILE_EXTENSION = /\.\w{1,10}$/;

/**
 * Extract the literal prefix from a pattern source (everything before the
 * first placeholder), stripped of leading segments shared with a base path.
 * e.g., "/new/docs/[slug]" → "docs/__p__" (the part after "/new/")
 */
function extractPatternSuffix(patternSource: string): string {
	// Replace placeholders with dummy values
	let result = patternSource.replace(SPLAT_RE, DUMMY_SEGMENT);
	SPLAT_RE.lastIndex = 0;
	result = result.replace(PARAM_RE, DUMMY_SEGMENT);
	// Strip leading slash and first segment (e.g., "/new/docs/__p__" → "docs/__p__")
	const parts = result.split("/").filter(Boolean);
	return parts.slice(1).join("/");
}

/**
 * Generate representative concrete paths from a template string.
 * Replaces [param] with a dummy segment and [...rest] with multiple
 * depth variants. For catch-alls, also generates representatives using
 * literal prefixes from existing pattern sources to catch cross-pattern loops.
 */
function generateRepresentatives(template: string, existingEdges?: RedirectEdge[]): string[] {
	const hasSplat = SPLAT_RE.test(template);
	SPLAT_RE.lastIndex = 0;

	if (hasSplat) {
		// Extract the static prefix before the catch-all (e.g., "/old/" from "/old/[...path]")
		const splatIndex = template.indexOf("[...");
		const prefix = template.slice(0, splatIndex);

		const reps = [
			template.replace(SPLAT_RE, DUMMY_SEGMENT).replace(PARAM_RE, DUMMY_SEGMENT),
			template
				.replace(SPLAT_RE, `${DUMMY_SEGMENT}/${DUMMY_SEGMENT}`)
				.replace(PARAM_RE, DUMMY_SEGMENT),
			template
				.replace(SPLAT_RE, `${DUMMY_SEGMENT}/${DUMMY_SEGMENT}/${DUMMY_SEGMENT}`)
				.replace(PARAM_RE, DUMMY_SEGMENT),
		];

		// Add representatives derived from existing pattern sources' literal prefixes
		if (existingEdges) {
			for (const edge of existingEdges) {
				if (edge.enabled && edge.isPattern && edge.source !== template) {
					const suffix = extractPatternSuffix(edge.source);
					if (suffix) {
						reps.push(`${prefix}${suffix}`);
					}
				}
			}
		}

		return reps;
	}

	return [template.replace(PARAM_RE, DUMMY_SEGMENT)];
}

/**
 * Resolve the next hop for a given path. Tries exact match first,
 * then pattern matching with parameter interpolation for concrete paths,
 * then representative-based matching for template strings.
 */
function resolveNext(
	path: string,
	graph: Map<string, { destination: string; id: string }>,
	patterns: CompiledPatternRedirect[],
	edges?: RedirectEdge[],
): { destination: string; id: string } | null {
	// Exact match (fast) — works for both real paths and template strings
	const exact = graph.get(path);
	if (exact) return exact;

	if (!path.includes("[")) {
		// Concrete path — try pattern matching directly
		if (FILE_EXTENSION.test(path)) return null;
		for (const pr of patterns) {
			const params = matchPattern(pr.compiled, path);
			if (params) {
				const resolved = interpolateDestination(pr.destination, params);
				return { destination: resolved, id: pr.id };
			}
		}
	} else {
		// Template string — generate representative paths and test against patterns
		const representatives = generateRepresentatives(path, edges);
		for (const pr of patterns) {
			for (const rep of representatives) {
				if (FILE_EXTENSION.test(rep)) continue;
				const params = matchPattern(pr.compiled, rep);
				if (params) {
					const resolved = interpolateDestination(pr.destination, params);
					return { destination: resolved, id: pr.id };
				}
			}
		}
	}

	return null;
}

/**
 * Build an adjacency map from redirect edges.
 * Includes both exact and pattern redirects — pattern redirects use their
 * template strings as literal graph edges, which works because EmDash
 * patterns pass parameters through without transformation.
 */
function buildGraph(edges: RedirectEdge[]): Map<string, { destination: string; id: string }> {
	const graph = new Map<string, { destination: string; id: string }>();
	for (const edge of edges) {
		if (edge.enabled) {
			graph.set(edge.source, { destination: edge.destination, id: edge.id });
		}
	}
	return graph;
}

/**
 * Most hops a walk resolves through pattern matching. Exact hops only move
 * between stored sources, but a pattern can rewrite a path into a new one that
 * a pattern matches again (`/[...path]` → `/moved/[...path]`), so such a chain
 * may never repeat a path or end. Browsers give up after 20 redirects, so a
 * longer chain fails for visitors the way a loop does.
 */
const MAX_PATTERN_HOPS = 20;

/**
 * Longest path a walk resolves through pattern matching. A destination can
 * repeat a captured parameter (`/[...path]/[...path]`), so a path can grow
 * faster than the hop limit catches; no server accepts a request line this long.
 */
const MAX_RESOLVED_PATH_LENGTH = 8192;

/** Compare paths in the form the runtime matches them in. */
function normalizeEdges(edges: RedirectEdge[]): RedirectEdge[] {
	return edges.map((edge) => ({
		...edge,
		source: normalizeSourcePath(edge.source),
		destination: normalizeSourcePath(edge.destination),
	}));
}

/**
 * Detect all redirect IDs that participate in cycles.
 * Walks every node in the graph once, collecting IDs from any cycles found.
 * A chain that patterns extend past `MAX_PATTERN_HOPS` or
 * `MAX_RESOLVED_PATH_LENGTH` counts as a cycle.
 *
 * @returns Array of redirect IDs that are part of a loop
 */
export function detectLoops(rawEdges: RedirectEdge[]): string[] {
	const edges = normalizeEdges(rawEdges);
	const graph = buildGraph(edges);
	const patterns = compilePatterns(edges);
	const visited = new Set<string>();
	const loopRedirectIds = new Set<string>();
	const endlessRedirectIds = new Set<string>();

	for (const [startSource] of graph) {
		if (visited.has(startSource)) continue;

		const path: string[] = [];
		const pathSet = new Set<string>();
		const pathIds: string[] = [];
		const patternHopIds: string[] = [];
		let current: string | undefined = startSource;

		// Only the latest pattern hops are reported; earlier hops may just lead into the chain
		const markEndless = () => {
			for (const id of patternHopIds.slice(-MAX_PATTERN_HOPS / 2)) {
				loopRedirectIds.add(id);
				endlessRedirectIds.add(id);
			}
		};

		while (current) {
			if (pathSet.has(current)) {
				// Found a cycle — collect IDs of redirects in the loop
				const loopStart = path.indexOf(current);
				for (const id of pathIds.slice(loopStart)) loopRedirectIds.add(id);
				break;
			}

			if (visited.has(current)) {
				break;
			}

			const resolvedByPattern = !graph.has(current);
			if (resolvedByPattern && current.length > MAX_RESOLVED_PATH_LENGTH) {
				markEndless();
				break;
			}

			const next = resolveNext(current, graph, patterns, edges);
			if (!next) break;

			if (resolvedByPattern) {
				// An endless chain is followed once, not again from each path leading into it
				if (endlessRedirectIds.has(next.id)) break;

				if (patternHopIds.length >= MAX_PATTERN_HOPS) {
					markEndless();
					break;
				}
				patternHopIds.push(next.id);
			}

			path.push(current);
			pathSet.add(current);
			pathIds.push(next.id);
			current = next.destination;
		}

		// Only the graph's own nodes are remembered: the paths patterns compute
		// are unbounded in number and length
		for (const node of path) {
			if (graph.has(node)) visited.add(node);
		}
	}

	return [...loopRedirectIds];
}

/**
 * Find a compiled pattern redirect whose source matches the given resolved path,
 * returning the source template string for display purposes.
 */
function findMatchingTemplate(
	resolvedPath: string,
	patterns: CompiledPatternRedirect[],
): string | null {
	for (const pr of patterns) {
		if (matchPattern(pr.compiled, resolvedPath) !== null) {
			return pr.compiled.source;
		}
	}
	return null;
}

/**
 * Check if adding or updating a redirect would create a loop.
 *
 * Walks the chain from `destination` through existing redirects.
 * If it reaches `source`, a cycle would form.
 *
 * @returns The loop path if a cycle would be created, or null if safe
 */
export function wouldCreateLoop(
	rawSource: string,
	rawDestination: string,
	existingEdges: RedirectEdge[],
	excludeId?: string,
): string[] | null {
	const source = normalizeSourcePath(rawSource);
	const destination = normalizeSourcePath(rawDestination);
	if (source === destination) return [rawSource, rawDestination];
	const filtered = normalizeEdges(
		excludeId ? existingEdges.filter((e) => e.id !== excludeId) : existingEdges,
	);
	const graph = buildGraph(filtered);
	const patterns = compilePatterns(filtered);

	// If the proposed source is a pattern, compile it so we can check
	// whether resolved paths would match it (not just string equality)
	// Decided before normalization, which decodes literal `%5B`/`%5D` into brackets
	const compiledSource =
		isPattern(rawSource) && validatePattern(source) === null ? compilePattern(source) : null;

	// Determine starting points for the walk. If the destination is a
	// template, generate representative concrete paths AND find existing
	// exact sources in the graph that match the template.
	let startingPoints: string[];
	if (destination.includes("[")) {
		const reps = generateRepresentatives(destination, filtered);
		// Also find existing exact graph keys that match this template
		if (validatePattern(destination) === null) {
			const compiled = compilePattern(destination);
			for (const [key] of graph) {
				if (!key.includes("[") && matchPattern(compiled, key) !== null) {
					reps.push(key);
				}
			}
		}
		// Always include the destination itself — it may be an exact graph key
		// (e.g., /a/sub/[...path] exists as a literal source in the graph)
		reps.push(destination);
		startingPoints = reps;
	} else {
		startingPoints = [destination];
	}

	for (const start of startingPoints) {
		const path = [source, destination];
		let current = start;
		const seen = new Set<string>([source, destination, start]);
		let patternHops = 0;

		// Walk the chain until it ends or we revisit a node
		// eslint-disable-next-line no-constant-condition -- terminates via return/break when chain ends or cycle found
		while (true) {
			const resolvedByPattern = !graph.has(current);
			if (resolvedByPattern && current.length > MAX_RESOLVED_PATH_LENGTH) return path;

			const next = resolveNext(current, graph, patterns, filtered);
			if (!next) break; // chain ends, try next starting point

			// Check if we've looped back — either exact match or pattern match
			const loopsBack =
				seen.has(next.destination) ||
				(compiledSource !== null && matchPattern(compiledSource, next.destination) !== null);

			if (loopsBack) {
				// Show the source template instead of dummy resolved path
				const displayPath =
					!seen.has(next.destination) && compiledSource !== null ? source : next.destination;
				path.push(displayPath);
				return path; // cycle found
			}

			if (resolvedByPattern && ++patternHops > MAX_PATTERN_HOPS) return path;

			// If the resolved path contains dummy segments, try to find the
			// original pattern template that produced it for cleaner display
			const cleanDest = next.destination.includes(DUMMY_SEGMENT)
				? (findMatchingTemplate(next.destination, patterns) ?? next.destination)
				: next.destination;
			path.push(cleanDest);
			seen.add(next.destination);
			current = next.destination;
		}
	}

	return null;
}
