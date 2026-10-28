import { readFileSync } from "node:fs";
import path from "node:path";

import { BaseSequencer } from "vitest/node";

import { assignShards, fileWeights } from "../../../.github/scripts/vitest-shard.mjs";

const times = JSON.parse(readFileSync(new URL("./shard-times.json", import.meta.url), "utf8"));

/**
 * Deals the test files out to `--shard` groups by their recorded durations
 * instead of by count, so the shards finish at about the same time.
 */
export class ShardSequencer extends BaseSequencer {
	async shard(files) {
		const { index, count } = this.ctx.config.shard;
		const root = this.ctx.config.root;
		const specs = new Map(
			files.map((spec) => [path.relative(root, spec.moduleId).split(path.sep).join("/"), spec]),
		);
		const weights = fileWeights([...specs.keys()], times);
		return assignShards(weights, count)[index - 1].map((name) => specs.get(name));
	}
}
