import * as React from "react";

import type { VideoEmbedBlock } from "../types.js";

export function VideoEmbedBlockComponent({ block }: { block: VideoEmbedBlock }) {
	const embedUrl = block.embedUrl || "";
	const title = block.title || "Video";
	const caption = block.caption;
	const poster = block.poster;

	if (!embedUrl) {
		return (
			<div className="rounded-lg border border-dashed border-kumo-line bg-kumo-tint/40 p-6 text-center text-sm text-kumo-subtle">
				No video URL provided
			</div>
		);
	}

	return (
		<figure className="space-y-3">
			<div className="relative overflow-hidden rounded-lg border border-kumo-line bg-kumo-tint">
				<iframe
					src={embedUrl}
					title={title}
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
					allowFullScreen
					className="aspect-video w-full"
					loading="lazy"
				/>
			</div>
			{caption && (
				<figcaption className="text-center text-sm text-kumo-subtle">{caption}</figcaption>
			)}
		</figure>
	);
}
