/**
 * Binding decision: production wiring stops at `assessment-pending`. Nothing
 * in a production code path may construct or call `AssessmentOrchestrator`
 * until W7/W8 land real stage adapters — it exists only to be exercised by
 * `assessment-orchestrator.test.ts`.
 *
 * `?raw` pulls each production entry point's source as a string (a Vite
 * import query, supported under `@cloudflare/vitest-pool-workers`'s Vite
 * pipeline) so this check runs without any filesystem access at test time —
 * a static grep for the module specifier, not a runtime behavioural test.
 */

import { describe, expect, it } from "vitest";

// oxlint's import/default rule can't see a Vite `?raw` module's synthetic
// default export, which is a real string at runtime (Vite transforms it).
// eslint-disable-next-line import/default
import discoveryConsumerSource from "../src/discovery-consumer.ts?raw";
// eslint-disable-next-line import/default
import discoveryDoSource from "../src/discovery-do.ts?raw";
// eslint-disable-next-line import/default
import indexSource from "../src/index.ts?raw";
// eslint-disable-next-line import/default
import jetstreamIngestorSource from "../src/jetstream-ingestor.ts?raw";
// eslint-disable-next-line import/default
import reconciliationSource from "../src/reconciliation.ts?raw";

const PRODUCTION_ENTRY_POINTS: Record<string, string> = {
	"index.ts": indexSource,
	"discovery-do.ts": discoveryDoSource,
	"discovery-consumer.ts": discoveryConsumerSource,
	"jetstream-ingestor.ts": jetstreamIngestorSource,
	"reconciliation.ts": reconciliationSource,
};

// Matches an actual import specifier (`from "./assessment-orchestrator.js"`
// or a dynamic `import(...)`), not prose mentioning the module by name in a
// doc comment.
const IMPORTS_ORCHESTRATOR =
	/(?:from\s+["'][^"']*assessment-orchestrator[^"']*["']|import\(\s*["'][^"']*assessment-orchestrator)/;

describe("production boundary: AssessmentOrchestrator is test-only", () => {
	for (const [name, source] of Object.entries(PRODUCTION_ENTRY_POINTS)) {
		it(`${name} never imports assessment-orchestrator`, () => {
			expect(source).not.toMatch(IMPORTS_ORCHESTRATOR);
		});
	}
});
