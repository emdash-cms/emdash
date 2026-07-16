/**
 * Boundary invariant: `AssessmentOrchestrator` reaches production through
 * exactly one door — `AssessmentWorkflow` (assessment-workflow.ts), which
 * constructs it per run. The queue consumer, discovery DO, Jetstream ingestor,
 * reconciliation pass, and worker entry must never construct or call it
 * directly; their job ends at dispatching a Workflow instance. This keeps the
 * per-subject serialization in one place (the Workflow instance id) rather than
 * letting an ad-hoc call site drive a run outside the lock.
 *
 * `?raw` pulls each entry point's source as a string (a Vite import query,
 * supported under `@cloudflare/vitest-pool-workers`'s Vite pipeline) so this
 * check runs without any filesystem access at test time — a static grep for the
 * module specifier, not a runtime behavioural test.
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

// Matches an actual import specifier — `from "...orchestrator..."`, a dynamic
// `import(...)`, or a bare side-effect `import "...orchestrator..."` — not
// prose mentioning the module by name in a doc comment.
const IMPORTS_ORCHESTRATOR =
	/(?:from\s+["'][^"']*assessment-orchestrator[^"']*["']|import\(\s*["'][^"']*assessment-orchestrator|import\s+["'][^"']*assessment-orchestrator)/;

describe("production boundary: AssessmentOrchestrator is reached only via the Workflow", () => {
	for (const [name, source] of Object.entries(PRODUCTION_ENTRY_POINTS)) {
		it(`${name} never imports assessment-orchestrator directly`, () => {
			expect(source).not.toMatch(IMPORTS_ORCHESTRATOR);
		});
	}
});
