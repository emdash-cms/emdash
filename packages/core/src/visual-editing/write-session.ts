export interface VisualEditingWriteSession {
	rev?: string;
	pending: Promise<void>;
	dirty: Set<string>;
	errors: Map<string, string>;
	fieldRevisions: Map<string, string>;
	enqueue<Result>(
		operation: (session: VisualEditingWriteSession) => Promise<Result>,
	): Promise<Result>;
}

export function getVisualEditingWriteSession(
	collection: string,
	id: string,
	rev?: string,
): VisualEditingWriteSession {
	const key = Symbol.for("emdash.visualEditing.writeSessions");
	const stored: Map<string, VisualEditingWriteSession> | undefined = Reflect.get(window, key);
	const sessions = stored ?? new Map<string, VisualEditingWriteSession>();
	if (!stored) Reflect.set(window, key, sessions);
	const entryKey = JSON.stringify([collection, id]);
	let session = sessions.get(entryKey);
	if (!session) {
		session = {
			rev,
			pending: Promise.resolve(),
			dirty: new Set(),
			errors: new Map(),
			fieldRevisions: new Map(),
			enqueue(operation) {
				const done = this.pending.then(() => operation(this));
				this.pending = done.then(
					() => undefined,
					() => undefined,
				);
				return done;
			},
		};
		sessions.set(entryKey, session);
	}
	if (!session.rev && rev) session.rev = rev;
	return session;
}
