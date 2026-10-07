import { isScalar, parseDocument, type Scalar } from "yaml";

export interface CatalogEdit {
	catalog: string;
	packageName: string;
	specifier: string;
}

export function catalogName(specifier: string): string | null {
	if (!specifier.startsWith("catalog:")) return null;
	return specifier.slice("catalog:".length) || "default";
}

function entryPaths(catalog: string, packageName: string): string[][] {
	const named = ["catalogs", catalog, packageName];
	return catalog === "default" ? [["catalog", packageName], named] : [named];
}

export function catalogEntry(
	workspaceManifest: string,
	catalog: string,
	packageName: string,
): string | undefined {
	const document = parseDocument(workspaceManifest);
	for (const path of entryPaths(catalog, packageName)) {
		const value: unknown = document.getIn(path);
		if (typeof value === "string") return value;
	}
	return undefined;
}

function renderScalar(type: Scalar.Type | undefined, value: string): string {
	switch (type) {
		case "PLAIN":
			return value;
		case "QUOTE_SINGLE":
			return `'${value.replaceAll("'", "''")}'`;
		default:
			return JSON.stringify(value);
	}
}

export function applyCatalogEdits(
	workspaceManifest: string,
	edits: readonly CatalogEdit[],
): string {
	const document = parseDocument(workspaceManifest);
	const replacements = new Map<number, { end: number; text: string }>();
	for (const edit of edits) {
		for (const path of entryPaths(edit.catalog, edit.packageName)) {
			const node = document.getIn(path, true);
			if (isScalar(node) && typeof node.value === "string" && node.range) {
				const [start, end] = node.range;
				replacements.set(start, { end, text: renderScalar(node.type, edit.specifier) });
				break;
			}
		}
	}
	let updated = workspaceManifest;
	for (const [start, { end, text }] of [...replacements].toSorted(([a], [b]) => b - a)) {
		updated = updated.slice(0, start) + text + updated.slice(end);
	}
	return updated;
}
