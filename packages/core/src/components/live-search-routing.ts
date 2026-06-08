export interface LiveSearchRoutableResult {
	collection: string;
	id: string;
	slug?: string | null;
}

export type LiveSearchRouteMap = Record<string, string>;

export function buildLiveSearchResultUrl(
	result: LiveSearchRoutableResult,
	routeMap: LiveSearchRouteMap = {},
): string {
	const path = result.slug ?? result.id;
	const template = routeMap[result.collection];

	if (!template) {
		return `/${result.collection}/${path}`;
	}

	return template
		.replaceAll(":collection", result.collection)
		.replaceAll(":id", result.id)
		.replaceAll(":slug", result.slug ?? result.id)
		.replaceAll(":path", path);
}
