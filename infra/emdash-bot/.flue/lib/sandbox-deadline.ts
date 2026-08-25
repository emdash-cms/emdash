export class DeadlineExceededError extends Error {
	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs}ms`);
		this.name = "DeadlineExceededError";
	}
}

export async function withDeadline<T>(
	operation: PromiseLike<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new DeadlineExceededError(label, timeoutMs)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
