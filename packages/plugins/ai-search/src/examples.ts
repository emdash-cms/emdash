import { recordSource, type SourceDeps } from "./sources.js";

const EXAMPLE_COUNT = 5;

export interface Example {
	id: string;
	title: string;
	/** Public path of the record, or null when it has none. */
	url: string | null;
}

/**
 * A few published records of a source with the address visitors would land on,
 * so the admin can check that the address points at the right page.
 */
export async function listExamples(
	deps: SourceDeps,
	source: string,
	urlTemplate: string | undefined,
): Promise<Example[]> {
	const records = recordSource(deps, source);
	const { items } = await records.list(EXAMPLE_COUNT);
	return Promise.all(
		items.map(async (record) => ({
			id: records.idOf(record),
			title: await records.titleOf(record),
			url: await records.urlOf(record, urlTemplate),
		})),
	);
}
