import { isScalar, parseDocument } from "yaml";

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

export function applyCatalogEdits(workspaceManifest: string, edits: readonly CatalogEdit[]): string {
	const document = parseDocument(workspaceManifest);
	for (const edit of edits) {
		for (const path of entryPaths(edit.catalog, edit.packageName)) {
			const node = document.getIn(path, true);
			if (isScalar(node) && typeof node.value === "string") {
				node.value = edit.specifier;
				break;
			}
		}
	}
	return document.toString();
}
