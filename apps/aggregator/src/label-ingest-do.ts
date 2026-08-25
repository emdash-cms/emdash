import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import { DurableObject } from "cloudflare:workers";

import { LabelIngestor } from "./label-ingestor.js";
import {
	activateLabelSourceAfterReplay,
	labelSourcePolicy,
	readLabelSourceTrust,
} from "./label-source-policy.js";
import { RealLabelQueryClient, RealLabelStreamClient } from "./label-stream-client.js";
import { LabelerResolver } from "./labeler-resolver.js";
import { getListingPolicy } from "./listing-policy.js";
import { acknowledgeProjectionWork, readProjectionWork } from "./projection-work.js";
import { rebuildPublicProjection, StaleProjectionRebuildError } from "./public-projection.js";
import { boundFetch } from "./utils.js";

const DID_KEY = "labeler:did";
const DIRTY_EPOCH_KEY = "projection:dirty-epoch";
const REBUILD_DEBOUNCE_MS = 250;
const MAX_REBUILD_ATTEMPTS = 3;
export const PROJECTION_COORDINATOR_NAME = "projection-rebuild";

export class LabelIngestDO extends DurableObject<Env> {
	private did: string | null = null;
	private ingestor: LabelIngestor | null = null;
	private runPromise: Promise<void> | null = null;
	private stopInProgress: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			const did = await ctx.storage.get<string>(DID_KEY);
			if (did) this.start(did);
		});
	}

	async wake(did: string): Promise<{
		did: string;
		cursor: number | null;
		consecutiveFailures: number;
	}> {
		await this.stopInProgress;
		if (!this.did) {
			await this.ctx.storage.put(DID_KEY, did);
			this.start(did);
		} else if (this.did !== did) {
			throw new TypeError("label ingest Durable Object DID mismatch");
		}
		return {
			did,
			cursor: this.ingestor?.currentCursor ?? null,
			consecutiveFailures: this.ingestor?.consecutiveFailures ?? 0,
		};
	}

	async stop(did: string): Promise<void> {
		if (this.stopInProgress) return this.stopInProgress;
		this.stopInProgress = this.finishStop(did);
		try {
			await this.stopInProgress;
		} finally {
			this.stopInProgress = null;
		}
	}

	private async finishStop(did: string): Promise<void> {
		if (this.did !== null && this.did !== did) {
			throw new TypeError("label ingest Durable Object DID mismatch");
		}
		const running = this.runPromise;
		this.ingestor?.stop();
		if (running) await running;
		this.ingestor = null;
		this.runPromise = null;
		this.did = null;
		await this.ctx.storage.delete(DID_KEY);
	}

	async markProjectionDirty(): Promise<void> {
		const epoch = (await this.ctx.storage.get<number>(DIRTY_EPOCH_KEY)) ?? 0;
		await this.ctx.storage.put(DIRTY_EPOCH_KEY, epoch + 1);
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + REBUILD_DEBOUNCE_MS);
	}

	override async alarm(): Promise<void> {
		const rebuildingEpoch = await this.ctx.storage.get<number>(DIRTY_EPOCH_KEY);
		if (rebuildingEpoch === undefined) return;
		const work = await readProjectionWork(this.env.DB);
		try {
			await rebuildProjection(this.env);
		} catch (error) {
			await this.ctx.storage.setAlarm(Date.now() + REBUILD_DEBOUNCE_MS);
			throw error;
		}
		if (work.rebuildPending) await acknowledgeProjectionWork(this.env.DB, work.dirtyEpoch);
		const currentEpoch = await this.ctx.storage.get<number>(DIRTY_EPOCH_KEY);
		if (currentEpoch === rebuildingEpoch) {
			await this.ctx.storage.delete(DIRTY_EPOCH_KEY);
			return;
		}
		await this.ctx.storage.setAlarm(Date.now() + REBUILD_DEBOUNCE_MS);
	}

	private start(did: string): void {
		if (this.ingestor) return;
		this.did = did;
		const resolver = new LabelerResolver(
			this.env.DB,
			new CompositeDidDocumentResolver({
				methods: {
					plc: new PlcDidDocumentResolver({ fetch: boundFetch }),
					web: new AtprotoWebDidDocumentResolver({ fetch: boundFetch }),
				},
			}),
		);
		this.ingestor = new LabelIngestor({
			did,
			db: this.env.DB,
			resolver,
			verificationKeys: (source) => resolver.verificationKeys(source),
			stream: new RealLabelStreamClient(),
			query: new RealLabelQueryClient(),
			onAccepted: () =>
				this.env.LABEL_INGEST_DO.getByName(PROJECTION_COORDINATOR_NAME).markProjectionDirty(),
			sourceTrust: {
				read: () => readLabelSourceTrust(this.env.DB, did),
				activate: async () => {
					const policy = labelSourcePolicy(await getListingPolicy(this.env));
					if (!policy.acceptedSources.has(did)) {
						throw new Error(`labeler is no longer configured: ${did}`);
					}
					if (!(await activateLabelSourceAfterReplay(this.env.DB, did, policy.policyVersion))) {
						throw new Error(`labeler activation conflicted with policy: ${did}`);
					}
				},
			},
		});
		this.runPromise = this.ingestor.run().catch((error) => {
			console.error(
				JSON.stringify({
					event: "label_ingestor_crashed",
					source: did,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		});
	}
}

export async function rebuildProjection(env: Env): Promise<void> {
	const policy = await getListingPolicy(env);
	if (!policy.moderationPolicy) return;
	for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt++) {
		try {
			await rebuildPublicProjection(env.DB, {
				listingPolicy: policy,
				evaluatedAt: new Date(),
			});
			return;
		} catch (error) {
			if (!(error instanceof StaleProjectionRebuildError)) throw error;
		}
	}
	throw new StaleProjectionRebuildError("projection remained stale after label acceptance");
}
