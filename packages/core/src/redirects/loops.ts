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
		if (edge.enabled && edge.isPattern) {
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
 * Detect all redirect IDs that participate in cycles.
 * Walks every node in the graph once, collecting IDs from any cycles found.
 *
 * @returns Array of redirect IDs that are part of a loop
 */
export function detectLoops(edges: RedirectEdge[]): string[] {
	const graph = buildGraph(edges);
	const patterns = compilePatterns(edges);
	const visited = new Set<string>();
	const loopRedirectIds = new Set<string>();

	for (const [startSource] of graph) {
		if (visited.has(startSource)) continue;

		const path: string[] = [];
		const pathSet = new Set<string>();
		const pathIds: string[] = [];
		let current: string | undefined = startSource;

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

			const next = resolveNext(current, graph, patterns, edges);
			if (!next) break;

			path.push(current);
			pathSet.add(current);
			pathIds.push(next.id);
			current = next.destination;
		}

		for (const node of path) visited.add(node);
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
	source: string,
	destination: string,
	existingEdges: RedirectEdge[],
	excludeId?: string,
): string[] | null {
	const filtered = excludeId ? existingEdges.filter((e) => e.id !== excludeId) : existingEdges;
	const graph = buildGraph(filtered);
	const patterns = compilePatterns(filtered);

	// If the proposed source is a pattern, compile it so we can check
	// whether resolved paths would match it (not just string equality)
	const sourceIsPattern = source.includes("[");
	const compiledSource = sourceIsPattern ? compilePattern(source) : null;

	// Determine starting points for the walk. If the destination is a
	// template, generate representative concrete paths AND find existing
	// exact sources in the graph that match the template.
	let startingPoints: string[];
	if (destination.includes("[")) {
		const reps = generateRepresentatives(destination, filtered);
		// Also find existing exact graph keys that match this template
		const compiled = compilePattern(destination);
		for (const [key] of graph) {
			if (!key.includes("[") && matchPattern(compiled, key) !== null) {
				reps.push(key);
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

		// Walk the chain until it ends or we revisit a node
		// eslint-disable-next-line no-constant-condition -- terminates via return/break when chain ends or cycle found
		while (true) {
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
