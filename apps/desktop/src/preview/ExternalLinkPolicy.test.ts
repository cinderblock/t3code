import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { externalNavigationTarget } from "./ExternalLinkPolicy.ts";

const target = (input: {
  behavior?: "in-app" | "system-browser";
  currentUrl?: string;
  navigationUrl: string;
}) =>
  externalNavigationTarget({
    behavior: input.behavior ?? "system-browser",
    currentUrl: input.currentUrl ?? "http://localhost:5173/app",
    navigationUrl: input.navigationUrl,
  });

describe("externalNavigationTarget", () => {
  it("sends a cross-origin navigation to the system browser", () => {
    expect(target({ navigationUrl: "https://github.com/anthropics" })).toStrictEqual(
      Option.some("https://github.com/anthropics"),
    );
  });

  it("keeps same-origin navigation in the panel", () => {
    expect(target({ navigationUrl: "http://localhost:5173/settings" })).toStrictEqual(
      Option.none(),
    );
  });

  it("treats a different port on the same host as a different origin", () => {
    expect(target({ navigationUrl: "http://localhost:3000/" })).toStrictEqual(
      Option.some("http://localhost:3000/"),
    );
  });

  it("treats an http -> https upgrade of the same host as a different origin", () => {
    expect(
      target({ currentUrl: "http://example.com/", navigationUrl: "https://example.com/" }),
    ).toStrictEqual(Option.some("https://example.com/"));
  });

  it("does nothing when the behavior is in-app", () => {
    expect(target({ behavior: "in-app", navigationUrl: "https://github.com" })).toStrictEqual(
      Option.none(),
    );
  });

  it("leaves non-http(s) targets alone so shell.openExternal never sees them", () => {
    for (const navigationUrl of [
      "mailto:someone@example.com",
      "vscode://file/tmp/x",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      expect(target({ navigationUrl })).toStrictEqual(Option.none());
    }
  });

  it("keeps the first navigation of a blank tab in the panel", () => {
    // A fresh guest sits on "" or about:blank. Bouncing its first navigation
    // to the system browser would leave the panel permanently empty.
    for (const currentUrl of ["", "about:blank"]) {
      expect(target({ currentUrl, navigationUrl: "https://example.com/" })).toStrictEqual(
        Option.none(),
      );
    }
  });

  it("ignores path, query, and hash when comparing origins", () => {
    expect(
      target({
        currentUrl: "https://example.com/a?x=1#one",
        navigationUrl: "https://example.com/b?y=2#two",
      }),
    ).toStrictEqual(Option.none());
  });

  it("treats a subdomain as a different origin", () => {
    expect(
      target({ currentUrl: "https://example.com/", navigationUrl: "https://docs.example.com/" }),
    ).toStrictEqual(Option.some("https://docs.example.com/"));
  });

  it("returns none for an unparseable navigation url", () => {
    expect(target({ navigationUrl: "not a url" })).toStrictEqual(Option.none());
  });
});
