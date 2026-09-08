import * as React from "react";

interface MediaSize {
	width: number;
	height: number;
}

export function useContainedMediaSize(
	frameRef: React.RefObject<HTMLElement | null>,
	sourceSize: MediaSize | null,
): MediaSize | null {
	const [frameSize, setFrameSize] = React.useState<MediaSize | null>(null);

	React.useLayoutEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const updateFrameSize = () => {
			const width = frame.clientWidth;
			const height = frame.clientHeight;
			if (width <= 0 || height <= 0) return;
			setFrameSize((current) =>
				current?.width === width && current.height === height ? current : { width, height },
			);
		};
		updateFrameSize();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateFrameSize);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [frameRef]);

	if (!sourceSize || !frameSize) return null;
	const scale = Math.min(frameSize.width / sourceSize.width, frameSize.height / sourceSize.height);
	return {
		width: sourceSize.width * scale,
		height: sourceSize.height * scale,
	};
}
