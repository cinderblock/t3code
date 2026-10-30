import { parseCodexFeedbackCommand } from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInteractionMode,
  ThreadContextRecord,
} from "@t3tools/contracts";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import { parseStandaloneComposerSlashCommand } from "../../composer-logic";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { deriveComposerSendState } from "../ChatView.logic";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

export type ComposerLocalCommand =
  | { readonly kind: "usage-limits" }
  | { readonly kind: "codex-feedback"; readonly feedback: { readonly reason?: string } }
  | { readonly kind: "interaction-mode"; readonly mode: ProviderInteractionMode };

/** The command the composer runs itself for this draft, or null for a prompt the provider gets. */
export function composerLocalCommand(input: {
  readonly prompt: string;
  readonly images: ReadonlyArray<unknown>;
  readonly files: ReadonlyArray<unknown>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly previewAnnotations: ReadonlyArray<unknown>;
  readonly reviewComments: ReadonlyArray<unknown>;
  readonly threadContexts: ReadonlyArray<unknown>;
  readonly selectedProvider: ProviderDriverKind;
  readonly interactionModeEnabled: boolean;
  readonly usageLimitsOffered: boolean;
}): ComposerLocalCommand | null {
  const { trimmedPrompt, sendableTerminalContexts } = deriveComposerSendState({
    prompt: input.prompt,
    imageCount: 0,
    terminalContexts: input.terminalContexts,
  });
  if (
    input.images.length > 0 ||
    input.files.length > 0 ||
    sendableTerminalContexts.length > 0 ||
    input.previewAnnotations.length > 0 ||
    input.reviewComments.length > 0 ||
    input.threadContexts.length > 0
  ) {
    return null;
  }
  if (input.usageLimitsOffered && isUsageLimitsCommand(trimmedPrompt)) {
    return { kind: "usage-limits" };
  }
  const feedback =
    input.selectedProvider === "codex" ? parseCodexFeedbackCommand(trimmedPrompt) : null;
  if (feedback) return { kind: "codex-feedback", feedback };
  const mode = input.interactionModeEnabled
    ? parseStandaloneComposerSlashCommand(trimmedPrompt)
    : null;
  return mode ? { kind: "interaction-mode", mode } : null;
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}
