import { describe, expect, it } from "vitest";
import { canvasActionNeedsDialog } from "./canvasActionDialog";

describe("canvas action dialog compatibility", () => {
  it("keeps actions without a dialog on the immediate-run path", () => {
    expect(canvasActionNeedsDialog(undefined)).toBe(false);
    expect(canvasActionNeedsDialog({})).toBe(false);
    expect(canvasActionNeedsDialog({ dialog: { enabled: true, params: [] } })).toBe(false);
  });
});
