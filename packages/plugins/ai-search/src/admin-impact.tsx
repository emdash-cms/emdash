import { Banner } from "@cloudflare/kumo";
import * as React from "react";

import type { Config } from "./config.js";
import { indexImpact, type SourceImpact } from "./impact.js";

const records = (count: number) =>
	`${count.toLocaleString()} ${count === 1 ? "record" : "records"}`;

function describe(impact: SourceImpact, label: string, count: number | undefined): string {
	const size = count === undefined ? "" : ` (${records(count)})`;
	switch (impact.change) {
		case "add":
			return `Adds ${label} to search.`;
		case "remove":
			return `Removes ${label} from search${size}.`;
		case "reindex":
			return `Uploads every ${label} record again${size}.`;
	}
}

/**
 * What saving `draft` over `saved` does to the index: nothing, a few sources,
 * or a full re-index. Hidden on first setup, when everything is new anyway.
 */
export function IndexImpactNote(props: {
	saved: Config | null;
	draft: Config;
	labels: Map<string, string>;
	counts: Record<string, number> | null;
}) {
	if (!props.saved) return null;
	const impacts = indexImpact(props.saved, props.draft);
	const enabled = Object.entries(props.draft.sources).filter(([, source]) => source.enabled);
	const countOf = (source: string) => props.counts?.[source];

	if (impacts.length === 0) {
		return (
			<p className="text-sm text-kumo-subtle">
				Nothing is re-indexed: the change applies to searches right away.
			</p>
		);
	}

	const everything =
		enabled.length > 0 &&
		enabled.every(([id]) =>
			impacts.some((impact) => impact.source === id && impact.change === "reindex"),
		);
	if (everything) {
		const total = enabled.reduce((sum, [id]) => sum + (countOf(id) ?? 0), 0);
		return (
			<Banner
				variant="alert"
				title="Saving re-indexes everything"
				description={`Every record is uploaded again${
					total > 0 ? ` (${records(total)})` : ""
				}. This can take a while on large sites.`}
			/>
		);
	}

	return (
		<div className="text-sm text-kumo-subtle">
			<p>When you save, only these sources change:</p>
			<ul className="list-disc ps-5">
				{impacts.map((impact) => (
					<li key={impact.source}>
						{describe(
							impact,
							props.labels.get(impact.source) ?? impact.source,
							countOf(impact.source),
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
