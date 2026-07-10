const CONTENT_OPERATION_QUEUES = Symbol.for("emdash.admin.content-operation-queues");

type OperationQueues = Map<string, Promise<void>>;

function getOperationQueues(): OperationQueues {
	const store = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = store[CONTENT_OPERATION_QUEUES];
	if (existing instanceof Map) return existing;

	const queues: OperationQueues = new Map();
	store[CONTENT_OPERATION_QUEUES] = queues;
	return queues;
}

/** Serialize operations that inspect or mutate the same content entry. */
export function enqueueContentOperation<T>(
	collection: string,
	entryId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const queueKey = `${collection}:${entryId}`;
	const queues = getOperationQueues();
	const previous = queues.get(queueKey) ?? Promise.resolve();
	const result = previous.then(operation);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);

	queues.set(queueKey, tail);
	void tail.then(() => {
		if (queues.get(queueKey) === tail) queues.delete(queueKey);
		return undefined;
	});
	return result;
}
