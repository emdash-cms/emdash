export interface LiveSearchRoutableResult {
	collection: string;
	id: string;
	slug?: string | null;
}

export type LiveSearchRouteMap = Record<string, string>;

function replaceRouteToken(template: string, token: string, value: string): string {
	return template.split(token).join(value);
}

export function buildLiveSearchResultUrl(
	result: LiveSearchRoutableResult,
	routeMap: LiveSearchRouteMap = {},
): string {
	const path = result.slug ?? result.id;
	const template = routeMap[result.collection];

	if (!template) {
		return `/${result.collection}/${path}`;
	}

	return [
		[":collection", result.collection],
		[":id", result.id],
		[":slug", result.slug ?? result.id],
		[":path", path],
	].reduce((url, [token, value]) => replaceRouteToken(url, token, value), template);
}
