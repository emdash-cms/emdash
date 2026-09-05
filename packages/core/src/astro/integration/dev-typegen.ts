import type { AstroIntegrationLogger } from "astro";

/**
 * Create a debounced refresh function that fetches the generated types from
 * the dev server and writes them to `emdash-env.d.ts` in the project root.
 *
 * This runs in the Astro integration (Node) and is registered for schema
 * mutations to call back into. It never runs in production builds or in
 * workerd SSR isolates, because only the integration registers it.
 */
export function createDebouncedTypegenRefresh(
	port: number,
	logger: AstroIntegrationLogger,
): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<unknown> | undefined;

	function refresh(): void {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (inFlight) return;
			inFlight = writeDevTypes(port, logger).finally(() => {
				inFlight = undefined;
			});
		}, 200);
	}

	return refresh;
}

async function writeDevTypes(port: number, logger: AstroIntegrationLogger): Promise<void> {
	const typegenUrl = `http://localhost:${port}/_emdash/api/typegen`;

	try {
		const { writeFile, readFile } = await import("node:fs/promises");
		const { resolve } = await import("node:path");
		const outputPath = resolve(process.cwd(), "emdash-env.d.ts");

		const response = await fetch(typegenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			logger.warn(`Typegen failed: ${response.status} ${body.slice(0, 200)}`);
			return;
		}

		const json = await response.json();
		if (typeof json !== "object" || json === null || !("data" in json)) {
			logger.warn("Typegen returned an unexpected response shape");
			return;
		}

		const result = json.data;
		if (
			typeof result !== "object" ||
			result === null ||
			!("types" in result) ||
			!("collections" in result)
		) {
			logger.warn("Typegen returned an unexpected response shape");
			return;
		}

		const types = result.types;
		const collections = result.collections;
		if (typeof types !== "string" || typeof collections !== "number") {
			logger.warn("Typegen returned an unexpected response shape");
			return;
		}

		let needsWrite = true;
		try {
			const existing = await readFile(outputPath, "utf-8");
			if (existing === types) needsWrite = false;
		} catch {
			// File doesn't exist yet
		}

		if (needsWrite) {
			await writeFile(outputPath, types, "utf-8");
			logger.info(`Generated emdash-env.d.ts (${collections} collections)`);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.warn(`Typegen failed: ${msg}`);
	}
}
