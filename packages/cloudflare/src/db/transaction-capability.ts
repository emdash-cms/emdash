const TRANSACTIONS_UNSUPPORTED_MARKER = Symbol.for("emdash:transactions-unsupported");

export function markTransactionsUnsupported<T extends object>(adapter: T): T {
	Object.defineProperty(adapter, TRANSACTIONS_UNSUPPORTED_MARKER, {
		value: true,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return adapter;
}
