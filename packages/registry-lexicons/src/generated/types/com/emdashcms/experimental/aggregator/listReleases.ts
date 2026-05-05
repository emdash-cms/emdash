import type {} from "@atcute/lexicons";
import type {} from "@atcute/lexicons/ambient";
import * as v from "@atcute/lexicons/validations";

import * as ComEmdashcmsExperimentalAggregatorDefs from "./defs.js";

const _mainSchema = /*#__PURE__*/ v.query("com.emdashcms.experimental.aggregator.listReleases", {
	params: /*#__PURE__*/ v.object({
		/**
		 * Pagination cursor from a previous response.
		 * @maxLength 1024
		 */
		cursor: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 1024)]),
		),
		/**
		 * Publisher DID.
		 */
		did: /*#__PURE__*/ v.didString(),
		/**
		 * Max results to return.
		 * @minimum 1
		 * @maximum 100
		 * @default 25
		 */
		limit: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [/*#__PURE__*/ v.integerRange(1, 100)]),
			25,
		),
		/**
		 * Parent package slug.
		 * @minLength 1
		 * @maxLength 64
		 */
		package: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(1, 64),
		]),
	}),
	output: {
		type: "lex",
		schema: /*#__PURE__*/ v.object({
			/**
			 * Cursor to fetch the next page. Absent when there are no more results.
			 * @maxLength 1024
			 */
			cursor: /*#__PURE__*/ v.optional(
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
					/*#__PURE__*/ v.stringLength(0, 1024),
				]),
			),
			/**
			 * @maxLength 100
			 */
			get releases() {
				return /*#__PURE__*/ v.constrain(
					/*#__PURE__*/ v.array(ComEmdashcmsExperimentalAggregatorDefs.releaseViewSchema),
					[/*#__PURE__*/ v.arrayLength(0, 100)],
				);
			},
		}),
	},
});

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params extends v.InferInput<mainSchema["params"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
	interface XRPCQueries {
		"com.emdashcms.experimental.aggregator.listReleases": mainSchema;
	}
}
