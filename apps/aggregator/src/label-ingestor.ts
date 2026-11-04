import {
	parseSignedListingLabel,
	verifyListingLabelWithPublicKey,
	type SignedListingLabel,
} from "@emdash-cms/registry-moderation";

import {
	acceptListingLabels,
	readLabelCursor,
	type AcceptedListingLabel,
} from "./label-ingestion.js";
import type {
	LabelQueryClient,
	LabelStreamClient,
	LabelStreamHandle,
} from "./label-stream-client.js";
import type {
	LabelerResolver,
	ResolvedLabelerIdentity,
	ResolvedLabelVerificationKey,
} from "./labeler-resolver.js";
import { acknowledgeProjectionScheduling, readProjectionWork } from "./projection-work.js";

export interface LabelSourceTrustState {
	trusted: boolean;
	replayGeneration: number;
}

export interface LabelSourceTrustControl {
	read(): Promise<LabelSourceTrustState>;
	activate(replayGeneration: number, activatedAt: Date): Promise<void>;
	markHealthy(observedAt: Date): Promise<void>;
	markFailure(observedAt: Date): Promise<boolean>;
}

export interface LabelIngestorOptions {
	did: string;
	db: D1Database;
	resolver: Pick<LabelerResolver, "resolve" | "resolveFresh">;
	verificationKeys?: Pick<LabelerResolver, "verificationKeys">["verificationKeys"];
	stream: LabelStreamClient;
	query: LabelQueryClient;
	onAccepted: () => Promise<void>;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	scheduleExpiry?: (callback: () => void, milliseconds: number) => () => void;
	sourceTrust?: LabelSourceTrustControl;
}

export class LabelIngestor {
	private stopped = false;
	private subscription: LabelStreamHandle | null = null;
	private cursor = 0;
	private failures = 0;
	private stopResolve!: () => void;
	private readonly stoppedPromise = new Promise<void>((resolve) => {
		this.stopResolve = resolve;
	});

	constructor(private readonly options: LabelIngestorOptions) {}

	get currentCursor(): number {
		return this.cursor;
	}

	get consecutiveFailures(): number {
		return this.failures;
	}

	async run(): Promise<void> {
		let cursorLoaded = false;
		while (!this.stopped) {
			try {
				if (!cursorLoaded) {
					this.cursor = await readLabelCursor(this.options.db, this.options.did);
					cursorLoaded = true;
				}
				await this.consumeOnce();
				this.failures = 0;
			} catch (error) {
				this.failures++;
				await this.recordFailure();
				console.warn(
					JSON.stringify({
						event: "label_subscription_failed",
						source: this.options.did,
						cursor: this.cursor,
						failures: this.failures,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			if (!this.stopped) {
				await Promise.race([
					(this.options.sleep ?? defaultSleep)(Math.min(60_000, 1_000 * 2 ** this.failures)),
					this.stoppedPromise,
				]);
			}
		}
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.subscription?.close();
		this.stopResolve();
	}

	private async consumeOnce(): Promise<void> {
		await this.scheduleProjectionWork();
		const initialTrust = (await this.options.sourceTrust?.read()) ?? {
			trusted: true,
			replayGeneration: 0,
		};
		let sourceTrusted = initialTrust.trusted;
		const replayGeneration = initialTrust.replayGeneration;
		let identity = await this.options.resolver.resolve(this.options.did);
		let verificationKeys: ResolvedLabelVerificationKey[] = [
			{ publicKey: identity.publicKey },
			...((await this.options.verificationKeys?.(this.options.did)) ?? []),
		];
		let refreshAvailable = true;
		const verify = async (values: readonly unknown[]): Promise<AcceptedListingLabel[]> => {
			this.assertIdentityFresh(identity);
			const accepted: AcceptedListingLabel[] = [];
			for (const value of values) {
				const signed = parseSignedListingLabel(value);
				let verified = await verifyWithKeys(signed, this.options.did, verificationKeys);
				if (!verified && refreshAvailable) {
					refreshAvailable = false;
					identity = await this.options.resolver.resolveFresh(this.options.did);
					this.assertIdentityFresh(identity);
					verificationKeys = [
						{ publicKey: identity.publicKey },
						...((await this.options.verificationKeys?.(this.options.did)) ?? []),
					];
					verified = await verifyWithKeys(signed, this.options.did, verificationKeys);
				}
				if (!verified) throw new TypeError("label signature does not match a retained source key");
				accepted.push({ signed, verified });
			}
			return accepted;
		};

		await this.replayQuery(() => identity, verify, sourceTrusted);
		const caughtUpTrust = (await this.options.sourceTrust?.read()) ?? initialTrust;
		if (caughtUpTrust.replayGeneration !== replayGeneration) {
			throw new Error("label source replay generation changed during catch-up");
		}
		if (!caughtUpTrust.trusted) {
			await this.options.sourceTrust?.activate(replayGeneration, new Date(this.now()));
			sourceTrusted = true;
			await this.scheduleProjectionWork();
		} else {
			sourceTrusted = true;
			await this.options.sourceTrust?.markHealthy(new Date(this.now()));
		}
		this.cursor = await readLabelCursor(this.options.db, this.options.did);
		this.assertIdentityFresh(identity);
		const subscription = this.options.stream.subscribe(identity.endpoint, this.cursor);
		this.subscription = subscription;
		const cancelExpiry = (this.options.scheduleExpiry ?? defaultScheduleExpiry)(
			() => subscription.close(),
			Math.max(0, identity.expiresAtEpochMs - this.now()),
		);
		try {
			for await (const frame of subscription) {
				if (this.stopped) return;
				const currentTrust = await this.options.sourceTrust?.read();
				if (
					currentTrust &&
					(!currentTrust.trusted || currentTrust.replayGeneration !== replayGeneration)
				) {
					throw new Error("label source trust changed; authoritative replay is required");
				}
				this.assertIdentityFresh(identity);
				if (frame.seq <= this.cursor) continue;
				if (frame.seq !== this.cursor + 1) {
					throw new Error(
						`subscribeLabels gap: expected ${this.cursor + 1}, received ${frame.seq}`,
					);
				}
				const labels = await verify(frame.labels);
				const accepted = await acceptListingLabels({
					db: this.options.db,
					source: this.options.did,
					labels,
					sourceSequence: frame.seq,
					cursor: frame.seq,
					trusted: sourceTrusted,
				});
				this.cursor = frame.seq;
				await this.options.sourceTrust?.markHealthy(new Date(this.now()));
				if (accepted.projectionSchedulingPending) await this.scheduleProjectionWork();
			}
		} finally {
			cancelExpiry();
			subscription.close();
			if (this.subscription === subscription) this.subscription = null;
		}
	}

	private async replayQuery(
		identity: () => ResolvedLabelerIdentity,
		verify: (values: readonly unknown[]) => Promise<AcceptedListingLabel[]>,
		trusted: boolean,
	): Promise<void> {
		for (;;) {
			if (this.stopped) return;
			this.assertIdentityFresh(identity());
			const page = await this.options.query.query(
				identity().endpoint,
				this.options.did,
				this.cursor,
			);
			if (this.stopped) return;
			const labels = await verify(page.labels);
			if (this.stopped) return;
			const accepted = await acceptListingLabels({
				db: this.options.db,
				source: this.options.did,
				labels,
				...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
				trusted,
			});
			if (accepted.projectionSchedulingPending) await this.scheduleProjectionWork();
			if (page.nextCursor === undefined) return;
			this.cursor = page.nextCursor;
		}
	}

	private assertIdentityFresh(identity: ResolvedLabelerIdentity): void {
		if (this.now() >= identity.expiresAtEpochMs) {
			throw new Error("labeler DID resolution expired");
		}
	}

	private async scheduleProjectionWork(): Promise<void> {
		const work = await readProjectionWork(this.options.db);
		if (!work.schedulingPending) return;
		await this.options.onAccepted();
		await acknowledgeProjectionScheduling(this.options.db, work.dirtyEpoch);
	}

	private async recordFailure(): Promise<void> {
		if (!this.options.sourceTrust) return;
		try {
			if (await this.options.sourceTrust.markFailure(new Date(this.now()))) {
				await this.options.onAccepted();
			}
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "label_source_health_update_failed",
					source: this.options.did,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}

async function verifyWithKeys(
	signed: SignedListingLabel,
	expectedSource: string,
	keys: readonly ResolvedLabelVerificationKey[],
): Promise<AcceptedListingLabel["verified"] | null> {
	const createdAt = Date.parse(signed.cts);
	for (const key of keys) {
		if (key.validUntilEpochMs !== undefined && createdAt > key.validUntilEpochMs) continue;
		try {
			return await verifyListingLabelWithPublicKey({
				label: signed,
				expectedSource,
				publicKey: key.publicKey,
			});
		} catch {
			// A retained key may not match this event; try the next observed key.
		}
	}
	return null;
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultScheduleExpiry(callback: () => void, milliseconds: number): () => void {
	const timer = setTimeout(callback, milliseconds);
	return () => clearTimeout(timer);
}
