export interface ManagedRunLoop {
	run(): Promise<void>;
	stop(): void;
}

export interface RunLoopWaitUntil {
	waitUntil(promise: Promise<unknown>): void;
}

export class RestartableRunLoop<T extends ManagedRunLoop> {
	private instance: T | null = null;
	private running: Promise<void> | null = null;

	constructor(
		private readonly context: RunLoopWaitUntil,
		private readonly create: () => T,
		private readonly onCrash: (error: unknown) => void,
	) {}

	get current(): T | null {
		return this.instance;
	}

	ensureStarted(): T {
		if (this.instance && this.running) return this.instance;
		const instance = this.create();
		let anchored!: Promise<void>;
		anchored = instance
			.run()
			.catch((error: unknown) => this.onCrash(error))
			.finally(() => {
				if (this.running !== anchored) return;
				this.instance = null;
				this.running = null;
			});
		this.instance = instance;
		this.running = anchored;
		this.context.waitUntil(anchored);
		return instance;
	}

	async stopAndWait(): Promise<void> {
		const instance = this.instance;
		const running = this.running;
		instance?.stop();
		if (running) await running;
	}
}
