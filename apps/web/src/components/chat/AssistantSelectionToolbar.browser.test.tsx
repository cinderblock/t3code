import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const TEXT =
  "The quick brown fox jumps over the lazy dog while the citation toolbar waits for a release.";

let root: Root;
let viewport: HTMLDivElement;
let text: Text;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = document.createElement("div");
  viewport.style.cssText = "position:fixed;left:0;top:0;width:600px;height:400px";
  // The left margin leaves room to release a drag beside the text rather than on it.
  viewport.innerHTML = `<p data-assistant-citation-source="message" style="margin:40px 0 0 120px;width:220px;font:16px/20px monospace"></p>`;
  text = document.createTextNode(TEXT);
  viewport.firstElementChild!.append(text);
  document.body.append(viewport);
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <AssistantSelectionToolbar
        viewport={viewport}
        threadRef={{
          environmentId: EnvironmentId.make("local"),
          threadId: ThreadId.make("thread"),
        }}
        onCite={() => true}
      />,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  window.getSelection()?.removeAllRanges();
  viewport.remove();
  vi.unstubAllGlobals();
});

async function dragSelect(from: number, to: number, release: { x: number; y: number }) {
  text.parentElement!.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
  );
  window.getSelection()!.setBaseAndExtent(text, from, text, to);
  window.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: release.x, clientY: release.y }),
  );
  const button = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>("button[aria-label^='Cite']");
    expect(button).not.toBeNull();
    return button!;
  });
  // Its entrance animates transform, so measure where it settles.
  await Promise.all(button.getAnimations({ subtree: true }).map((animation) => animation.finished));
  return button.getBoundingClientRect();
}

function selectedLines(start: number, end: number) {
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const lines = Array.from(range.getClientRects());
  return { first: lines[0]!, last: lines.at(-1)! };
}

describe("AssistantSelectionToolbar placement", () => {
  // Releases beside the text are the common case for a right-to-left drag, which overshoots
  // the selection's start; a release on the text simply follows the pointer.
  it("anchors a right-to-left drag released beside the text under the selection's start", async () => {
    const { first, last } = selectedLines(4, 70);
    expect(last.bottom).toBeGreaterThan(first.bottom);

    const button = await dragSelect(70, 4, { x: 20, y: first.top + first.height / 2 });

    expect(button.left).toBeCloseTo(first.left, 0);
    expect(button.top).toBeCloseTo(first.bottom + 4, 0);
  });

  it("anchors a left-to-right drag released beside the text after the selection's end", async () => {
    const { last } = selectedLines(4, 70);

    const button = await dragSelect(4, 70, { x: 580, y: last.top + last.height / 2 });

    expect(button.left).toBeCloseTo(last.right, 0);
    expect(button.top).toBeCloseTo(last.bottom + 4, 0);
  });
});
