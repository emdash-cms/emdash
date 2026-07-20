import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as ComEmdashcmsExperimentalAggregatorDefs from "./defs.js";

const _mainSchema = /*#__PURE__*/ v.query(
	"com.emdashcms.experimental.aggregator.getPublisherVerification",
	{
		params: /*#__PURE__*/ v.object({
			/**
			 * Subject publisher DID.
			 */
			did: /*#__PURE__*/ v.didString(),
		}),
		output: {
			type: "lex",
			get schema() {
				return ComEmdashcmsExperimentalAggregatorDefs.publisherVerificationViewSchema;
			},
		},
	},
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params extends v.InferInput<mainSchema["params"]> {}
export type $output = v.InferXRPCBodyInput<mainSchema["output"]>;

declare module "@atcute/lexicons/ambient" {
	interface XRPCQueries {
		"com.emdashcms.experimental.aggregator.getPublisherVerification": mainSchema;
	}
}
