import { describe, expect, it } from "vite-plus/test";

import { resolveSelectionFocus } from "./selectionActions";

describe("resolveSelectionFocus", () => {
  it("anchors a backward selection under the start of its first line", () => {
    const lines = [
      { left: 180, right: 400, bottom: 100 },
      { left: 120, right: 300, bottom: 120 },
    ];
    expect(resolveSelectionFocus(lines, true)).toEqual({ x: 180, bottom: 100 });
    expect(resolveSelectionFocus(lines, false)).toEqual({ x: 300, bottom: 120 });
    expect(resolveSelectionFocus([], true)).toBeNull();
  });
});
