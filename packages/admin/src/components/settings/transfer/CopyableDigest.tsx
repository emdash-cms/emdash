import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, Copy } from "@phosphor-icons/react";
import * as React from "react";

/** Copy `text` to the clipboard, reporting success for two seconds. */
export function useCopyToClipboard(): [boolean, (text: string) => Promise<void>] {
	const [copied, setCopied] = React.useState(false);
	const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	React.useEffect(() => () => clearTimeout(timer.current), []);
	const copy = React.useCallback(async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(setCopied, 2000, false);
	}, []);
	return [copied, copy];
}

export function CopyableDigest({ label, digest }: { label: string; digest: string }) {
	const { t } = useLingui();
	const [copied, copy] = useCopyToClipboard();
	return (
		<div className="grid gap-1 text-sm">
			<span className="text-kumo-subtle">{label}</span>
			<div className="flex min-w-0 items-center gap-2">
				<code
					className="min-w-0 flex-1 truncate rounded-md bg-kumo-tint px-2 py-1 font-mono text-xs"
					dir="ltr"
					title={digest}
				>
					{digest}
				</code>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					shape="square"
					aria-label={copied ? t`Copied` : t`Copy ${label}`}
					onClick={() => void copy(digest)}
				>
					{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
				</Button>
			</div>
		</div>
	);
}
