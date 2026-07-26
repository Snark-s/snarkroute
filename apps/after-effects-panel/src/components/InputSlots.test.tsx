// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputSlots } from "./InputSlots";

afterEach(cleanup);

describe("InputSlots", () => {
  it("renders distinct role, collection, audio, and video controls from the normalized contract", () => {
    const onAdd = vi.fn();
    render(<InputSlots slots={[
      { slotId: "first", kind: "image", role: "firstFrame", label: "First frame", minItems: 1, maxItems: 1, required: true, ordered: true, items: [null] },
      { slotId: "last", kind: "image", role: "lastFrame", label: "Last frame", minItems: 0, maxItems: 1, required: false, ordered: true, items: [null] },
      { slotId: "refs", kind: "image", role: "reference", label: "Reference images", minItems: 1, maxItems: 4, required: true, ordered: true, items: [null] },
      { slotId: "audio", kind: "audio", role: "audio", label: "Audio", minItems: 0, maxItems: 1, required: false, ordered: true, items: [null] },
      { slotId: "video", kind: "video", role: "sourceVideo", label: "Source video", minItems: 1, maxItems: 1, required: true, ordered: true, items: [null] }
    ]} onSource={vi.fn()} onAdd={onAdd} onRemove={vi.fn()} onMove={vi.fn()} onReveal={vi.fn()} />);
    expect(screen.getByText(/First frame/)).toBeTruthy();
    expect(screen.getByText(/Last frame/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "External audio file…" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "External video file…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add image" }));
    expect(onAdd).toHaveBeenCalledWith("refs");
  });
});
