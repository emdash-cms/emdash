import { describe, expect, it } from "vitest";

import { MOTIFS, pluginArt, pluginArtSeed } from "./plugin-art.js";

const seeds = Array.from({ length: 200 }, (_, i) =>
	pluginArtSeed({ did: `did:plc:publisher${i % 7}`, slug: `plugin-${i}` }),
);

describe("plugin art", () => {
	it("draws the same art for the same seed", () => {
		expect(pluginArt(seeds[0]!, "tile")).toEqual(pluginArt(seeds[0]!, "tile"));
		expect(pluginArt(seeds[0]!, "feature")).toEqual(pluginArt(seeds[0]!, "feature"));
	});

	it("gives different plugins different art and uses every motif", () => {
		const tiles = new Set(seeds.map((seed) => JSON.stringify(pluginArt(seed, "tile").layers)));
		const motifs = new Set(seeds.map((seed) => pluginArt(seed, "tile").motif));
		expect(tiles.size).toBeGreaterThan(seeds.length * 0.6);
		expect(motifs.size).toBe(MOTIFS.length);
	});

	it("keeps every tile small and gives it an orange focus", () => {
		for (const seed of seeds) {
			const art = pluginArt(seed, "tile");
			expect(art.dotCount).toBeGreaterThan(10);
			expect(art.layers.some((layer) => layer.accent)).toBe(true);
			const pathBytes = art.layers.reduce((total, layer) => total + layer.d.length, 0);
			expect(pathBytes).toBeLessThan(1200);
		}
	});
});
