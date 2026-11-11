import * as React from "react";
import { expect, it, vi } from "vitest";

import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));

const VALUE = [
	{
		_type: "block" as const,
		_key: "a",
		style: "normal" as const,
		markDefs: [],
		children: [{ _type: "span" as const, _key: "a:s", text: "Opened editable", marks: [] }],
	},
];

it("turns read-only and back after mounting, without reporting a change", async () => {
	const onChange = vi.fn();
	const screen = await render(<PortableTextEditor value={VALUE} onChange={onChange} />);
	const pm = await vi.waitFor(() => {
		const element = document.querySelector<HTMLElement>(".ProseMirror");
		expect(element).not.toBeNull();
		return element!;
	});
	// The drag handle's plugin has moved the handle out of React's tree.
	await vi.waitFor(() => expect(document.querySelector(".drag-handle")).not.toBeNull());

	await screen.rerender(<PortableTextEditor value={VALUE} onChange={onChange} editable={false} />);
	await vi.waitFor(() => expect(pm.getAttribute("contenteditable")).toBe("false"));
	await screen.rerender(<PortableTextEditor value={VALUE} onChange={onChange} />);
	await vi.waitFor(() => expect(pm.getAttribute("contenteditable")).toBe("true"));

	expect(pm.isConnected).toBe(true);
	expect(onChange).not.toHaveBeenCalled();
	await screen.unmount();
});

it("tells assistive technology while it's read-only", async () => {
	const screen = await render(<PortableTextEditor value={VALUE} onChange={vi.fn()} />);
	const textbox = screen.getByRole("textbox", { name: "Rich text editor" });
	await expect.element(textbox).not.toHaveAttribute("aria-readonly");

	await screen.rerender(<PortableTextEditor value={VALUE} onChange={vi.fn()} editable={false} />);
	await expect.element(textbox).toHaveAttribute("aria-readonly", "true");
	await screen.rerender(<PortableTextEditor value={VALUE} onChange={vi.fn()} />);
	await expect.element(textbox).not.toHaveAttribute("aria-readonly");
	await screen.unmount();
});
