import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as ComEmdashcmsExperimentalLabellerDefs from "./defs.js";

const _mainSchema = /*#__PURE__*/ v.query(
	"com.emdashcms.experimental.labeller.getPolicy",
	{
		params: null,
		output: {
			type: "lex",
			get schema() {
				return ComEmdashcmsExperimentalLabellerDefs.labelerPolicySchema;
			},
		},
	},
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params {}
export type $output = v.InferXRPCBodyInput<mainSchema["output"]>;

declare module "@atcute/lexicons/ambient" {
	interface XRPCQueries {
		"com.emdashcms.experimental.labeller.getPolicy": mainSchema;
	}
}
