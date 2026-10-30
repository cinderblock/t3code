import { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import {
  approvalRedirectNotice,
  composerLocalCommand,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("composerLocalCommand", () => {
  const draft = (prompt: string) => ({
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    selectedProvider: ProviderDriverKind.make("codex"),
    interactionModeEnabled: true,
    usageLimitsOffered: true,
  });

  it("finds the commands a send handles without starting a turn", () => {
    expect(composerLocalCommand(draft("/plan"))).toEqual({
      kind: "interaction-mode",
      mode: "plan",
    });
    expect(composerLocalCommand(draft(" /DEFAULT\n"))).toEqual({
      kind: "interaction-mode",
      mode: "default",
    });
    expect(composerLocalCommand(draft("/feedback the diff is wrong"))).toEqual({
      kind: "codex-feedback",
      feedback: { reason: "the diff is wrong" },
    });
    expect(composerLocalCommand(draft("/usage-limits"))).toEqual({ kind: "usage-limits" });
  });

  it("leaves commands the provider runs as prompts", () => {
    for (const prompt of ["/compact", "/compact keep the API notes", "/review", "/planning"]) {
      expect(composerLocalCommand(draft(prompt))).toBeNull();
    }
  });

  it("leaves a command to the provider where the composer doesn't handle it", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    expect(composerLocalCommand({ ...draft("/feedback"), selectedProvider: claude })).toBeNull();
    expect(composerLocalCommand({ ...draft("/plan"), interactionModeEnabled: false })).toBeNull();
    expect(
      composerLocalCommand({ ...draft("/usage-limits"), usageLimitsOffered: false }),
    ).toBeNull();
  });

  it("treats a command sent with anything else as a prompt", () => {
    expect(composerLocalCommand({ ...draft("/plan"), threadContexts: [localThread] })).toBeNull();
    expect(
      composerLocalCommand({
        ...draft("/feedback"),
        terminalContexts: [
          {
            id: "live",
            threadId: ThreadId.make("a"),
            terminalId: "default",
            terminalLabel: "Terminal 1",
            lineStart: 1,
            lineEnd: 1,
            createdAt: "2026-10-30T18:00:00.000Z",
            text: "output",
          },
        ],
      }),
    ).toBeNull();
  });

  it("ignores an expired terminal context, which a send drops", () => {
    expect(
      composerLocalCommand({
        ...draft("/plan"),
        terminalContexts: [
          {
            id: "expired",
            threadId: ThreadId.make("a"),
            terminalId: "default",
            terminalLabel: "Terminal 1",
            lineStart: 1,
            lineEnd: 1,
            createdAt: "2026-10-30T18:00:00.000Z",
            text: "",
          },
        ],
      }),
    ).toEqual({ kind: "interaction-mode", mode: "plan" });
  });
});

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});
