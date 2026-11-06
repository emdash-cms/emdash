import { Banner, Button, InputArea } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

export function isNonListValue(value: unknown): boolean {
	if (value == null || Array.isArray(value)) return false;
	return !(typeof value === "string" && value.trim() === "");
}

export interface NonListFieldValueProps {
	id?: string;
	label: string;
	value: unknown;
	onReplace: () => void;
}

export function NonListFieldValue({ id, label, value, onReplace }: NonListFieldValueProps) {
	const { t } = useLingui();
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

	return (
		<div className="grid gap-2">
			<InputArea id={id} label={label} value={text} readOnly rows={3} dir="auto" />
			<Banner
				variant="alert"
				role="alert"
				title={t`The stored value doesn't match this field's type`}
				description={t`This field expects a list. The stored value stays unchanged until you replace it with an empty list, which deletes it. Copy anything you need from it first.`}
				action={
					<Button size="sm" variant="secondary" type="button" onClick={onReplace}>
						{t`Replace with empty list`}
					</Button>
				}
			/>
		</div>
	);
}
