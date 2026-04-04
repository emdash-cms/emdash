import type { FieldsBlock } from "../types.js";

export function FieldsBlockComponent({ block }: { block: FieldsBlock }) {
	return (
		<div className="grid grid-cols-2 gap-x-6 gap-y-3">
			{block.fields.map((field, i) => (
				<div key={i}>
					<div className="text-sm text-kumo-subtle">{field.label}</div>
					<div className="text-kumo-default truncate" title={field.value}>{field.value}</div>
				</div>
			))}
		</div>
	);
}
