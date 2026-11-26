import { InsertQueryNode, type KyselyPlugin } from "kysely";

/**
 * The built-in SQLite driver answers synchronously, so one request's queries
 * never interleave with another's. D1, PostgreSQL and remote libSQL answer
 * over I/O; yielding to the event loop after every query models that, so
 * concurrent requests can interleave as they would in production.
 */
export const answersOverIo: KyselyPlugin = {
	transformQuery: (args) => args.node,
	transformResult: async (args) => {
		await new Promise((resolve) => setImmediate(resolve));
		return args.result;
	},
};

/**
 * Fails the first insert into `table`, as if the request stopped between
 * two writes. Later inserts run normally.
 */
export function failFirstInsertInto(table: string): KyselyPlugin {
	let failed = false;
	return {
		transformQuery: (args) => {
			const node = args.node;
			if (!failed && InsertQueryNode.is(node) && node.into?.table.identifier.name === table) {
				failed = true;
				throw new Error(`Insert into ${table} failed`);
			}
			return node;
		},
		transformResult: async (args) => args.result,
	};
}
