/**
 * Astro recursively decodes route parameters. WordPress menu names can contain
 * literal percent escapes, so recover the name from the URL with one decode.
 */
const MENU_NAME_PATTERN = /\/_emdash\/api\/menus\/([^/]+)/;

export function getMenuName(request: Request): string {
	const encodedName = new URL(request.url).pathname.match(MENU_NAME_PATTERN)?.[1];
	if (!encodedName) throw new Error("Menu name is missing from the request URL");
	return decodeURIComponent(encodedName);
}
