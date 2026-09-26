import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import { DurableObject } from "cloudflare:workers";

import { LabelIngestor } from "./label-ingestor.js";
import {
	markLabelSourceFailure,
	markLabelSourceHealthy,
	readLabelSourceActivationState,
	stageLabelSourceReplay,
} from "./label-source-health.js";
import { activateLabelSourceAfterReplay, labelSourcePolicy } from "./label-source-policy.js";
import { RealLabelQueryClient, RealLabelStreamClient } from "./label-stream-client.js";
import { LabelerResolver } from "./labeler-resolver.js";
import { getListingPolicy } from "./listing-policy.js";
import { acknowledgeProjectionWork, readProjectionWork } from "./projection-work.js";
import { rebuildPublicProjection, StaleProjectionRebuildError } from "./public-projection.js";
import { RestartableRunLoop } from "./run-loop-lifecycle.js";
import { boundFetch } from "./utils.js";

const DID_KEY = "labeler:did";
const DIRTY_EPOCH_KEY = "projection:dirty-epoch";
const REBUILD_DEBOUNCE_MS = 250;
const MAX_REBUILD_ATTEMPTS = 3;
export const PROJECTION_COORDINATOR_NAME = "projection-rebuild";

export class LabelIngestDO extends DurableObject<Env> {
	private did: string | null = null;
	private readonly runLoop: RestartableRunLoop<LabelIngestor>;
	private stopInProgress: Promise<void> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runLoop = new RestartableRunLoop(
			ctx,
			() => this.createIngestor(),
			(error) => {
				console.error(
					JSON.stringify({
						event: "label_ingestor_crashed",
						source: this.did,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			},
		);
		void ctx.blockConcurrencyWhile(async () => {
			const did = await ctx.storage.get<string>(DID_KEY);
			if (did) {
				this.did = did;
				this.runLoop.ensureStarted();
			}
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
			this.did = did;
		} else if (this.did !== did) {
			throw new TypeError("label ingest Durable Object DID mismatch");
		}
		const ingestor = this.runLoop.ensureStarted();
		return {
			did,
			cursor: ingestor.currentCursor,
			consecutiveFailures: ingestor.consecutiveFailures,
		};
	}

	async stop(did: string): Promise<void> {
		await this.runWithStopFence(() => this.finishStop(did));
	}

	async replay(did: string, observedAt: string): Promise<void> {
		const replayTime = new Date(observedAt);
		if (!Number.isFinite(replayTime.getTime())) throw new TypeError("replay time is invalid");
		await this.runWithStopFence(async () => {
			if (this.did !== null && this.did !== did) {
				throw new TypeError("label ingest Durable Object DID mismatch");
			}
			await this.runLoop.stopAndWait();
			if (!(await stageLabelSourceReplay(this.env.DB, did, replayTime))) {
				throw new Error(`label source could not be staged for replay: ${did}`);
			}
			if (!this.did) {
				this.did = did;
				await this.ctx.storage.put(DID_KEY, did);
			}
			this.runLoop.ensureStarted();
		});
	}

	private async runWithStopFence(operation: () => Promise<void>): Promise<void> {
		while (this.stopInProgress) await this.stopInProgress;
		const running = operation();
		this.stopInProgress = running;
		try {
			await running;
		} finally {
			if (this.stopInProgress === running) this.stopInProgress = null;
		}
	}

	private async finishStop(did: string): Promise<void> {
		if (this.did !== null && this.did !== did) {
			throw new TypeError("label ingest Durable Object DID mismatch");
		}
		await this.runLoop.stopAndWait();
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

	private createIngestor(): LabelIngestor {
		const did = this.did;
		if (!did) throw new Error("label ingest Durable Object has no configured DID");
		const resolver = new LabelerResolver(
			this.env.DB,
			new CompositeDidDocumentResolver({
				methods: {
					plc: new PlcDidDocumentResolver({ fetch: boundFetch }),
					web: new AtprotoWebDidDocumentResolver({ fetch: boundFetch }),
				},
			}),
		);
		return new LabelIngestor({
			did,
			db: this.env.DB,
			resolver,
			verificationKeys: (source) => resolver.verificationKeys(source),
			stream: new RealLabelStreamClient(),
			query: new RealLabelQueryClient(),
			onAccepted: () =>
				this.env.LABEL_INGEST_DO.getByName(PROJECTION_COORDINATOR_NAME).markProjectionDirty(),
			sourceTrust: {
				read: () => readLabelSourceActivationState(this.env.DB, did),
				activate: async (replayGeneration, activatedAt) => {
					const policy = labelSourcePolicy(await getListingPolicy(this.env));
					if (!policy.acceptedSources.has(did)) {
						throw new Error(`labeler is no longer configured: ${did}`);
					}
					if (
						!(await activateLabelSourceAfterReplay(
							this.env.DB,
							did,
							policy.policyVersion,
							replayGeneration,
							activatedAt,
						))
					) {
						throw new Error(`labeler activation conflicted with policy: ${did}`);
					}
				},
				markHealthy: (observedAt) => markLabelSourceHealthy(this.env.DB, did, observedAt),
				markFailure: (observedAt) => markLabelSourceFailure(this.env.DB, did, observedAt),
			},
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
