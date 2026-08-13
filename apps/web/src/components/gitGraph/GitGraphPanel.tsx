import type { EnvironmentId, VcsGraphRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { layoutGitGraph } from "~/lib/gitGraphLayout";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { GitGraphRowGlyph, GIT_GRAPH_LANE_WIDTH, GIT_GRAPH_ROW_HEIGHT } from "./GitGraphRowGlyph";
import {
  buildWorktreeRows,
  formatCommitAge,
  groupGraphRefsByOid,
  remoteChipColors,
  shortOid,
  splitVisibleGraphRefs,
  type GitGraphWorktreeRow,
} from "./gitGraphPresentation";

/**
 * Every ref renders as a pill. Remote pills are tinted per remote, so
 * `origin/main` and `upstream/main` are distinguishable without reading the
 * whole truncated name.
 */
function RefChip(props: { graphRef: VcsGraphRef }) {
  const { graphRef } = props;
  const remoteColors =
    graphRef.kind === "remote" && graphRef.remoteName !== null
      ? remoteChipColors(graphRef.remoteName)
      : null;

  return (
    <span
      className={cn(
        // `inline-block`, not `inline-flex`: `text-overflow: ellipsis` does not
        // apply to a flex container's anonymous text child, so an inline-flex
        // chip spills its branch name over the neighbouring column instead of
        // truncating. `min-w-0` lets a long name give ground rather than push.
        "inline-block min-w-0 max-w-[9rem] truncate rounded-full border px-1.5 py-px align-middle text-[10px] leading-4",
        graphRef.current
          ? "border-primary/50 bg-primary/15 font-medium text-primary"
          : graphRef.kind === "tag"
            ? "border-warning/40 bg-warning/10 text-warning-foreground"
            : remoteColors
              ? "text-foreground"
              : graphRef.kind === "remote"
                ? // A remote whose name git did not resolve; still a pill, just
                  // without an identity colour.
                  "border-border bg-muted/60 text-foreground"
                : "border-border bg-muted text-foreground",
      )}
      style={
        remoteColors
          ? { borderColor: remoteColors.border, backgroundColor: remoteColors.background }
          : undefined
      }
    >
      {graphRef.name}
    </span>
  );
}

export function GitGraphPanel(props: {
  environmentId: EnvironmentId;
  cwd: string | null;
  /** The worktree this thread works in; its rows sort to the top. */
  activeWorktreePath?: string | null;
}) {
  const { environmentId, cwd } = props;
  const activeWorktreePath = props.activeWorktreePath ?? null;

  const snapshotQuery = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.graphSnapshot({ environmentId, input: { cwd } }),
  );
  const snapshot = snapshotQuery.data;

  // Only ask about worktrees this snapshot actually reported, and only once the
  // panel has a snapshot — so opening the tab costs one `git status` per real
  // worktree, and closing it costs nothing.
  const worktreePaths = useMemo(
    () => (snapshot?.worktrees ?? []).map((worktree) => worktree.path).toSorted(),
    [snapshot?.worktrees],
  );
  const worktreeChangesQuery = useEnvironmentQuery(
    cwd === null || worktreePaths.length === 0
      ? null
      : vcsEnvironment.worktreeChanges({ environmentId, input: { cwd, worktreePaths } }),
  );
  const worktreeRows = useMemo(
    () =>
      buildWorktreeRows({
        worktrees: snapshot?.worktrees ?? [],
        changes: worktreeChangesQuery.data?.worktrees ?? [],
        activeWorktreePath,
      }),
    [snapshot?.worktrees, worktreeChangesQuery.data?.worktrees, activeWorktreePath],
  );

  const hasMultipleWorktrees = new Set(worktreeRows.map((row) => row.worktreePath)).size > 1;

  const layout = useMemo(() => layoutGitGraph(snapshot?.commits ?? []), [snapshot?.commits]);
  const refsByOid = useMemo(() => groupGraphRefsByOid(snapshot?.refs ?? []), [snapshot?.refs]);
  // Read once per render rather than per row, so every age on screen is
  // measured against the same instant.
  const nowMs = Date.now();

  const header = (
    <div
      className="surface-subheader flex items-center justify-between gap-2 px-4"
      data-surface-subheader
    >
      <span className="truncate text-sm font-medium">History</span>
      <div className="flex shrink-0 items-center gap-2">
        {snapshot ? (
          <span className="text-xs text-muted-foreground">
            {snapshot.commits.length}
            {snapshot.nextCursor === null ? "" : "+"} commits
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={snapshotQuery.refresh}
          disabled={cwd === null}
          aria-label="Refresh history"
        >
          <RefreshCwIcon className={cn("size-4", snapshotQuery.isPending && "animate-spin")} />
        </Button>
      </div>
    </div>
  );

  const body = () => {
    if (cwd === null) {
      return <EmptyState message="Open a project to see its history." />;
    }
    if (snapshotQuery.error !== null) {
      return <EmptyState message={snapshotQuery.error} />;
    }
    if (snapshot === null) {
      return <LoadingState />;
    }
    if (!snapshot.isRepo) {
      return <EmptyState message="This project is not a git repository." />;
    }
    if (snapshot.commits.length === 0) {
      return <EmptyState message="No commits yet." />;
    }

    return (
      <div className="min-h-0 flex-1 overflow-auto">
        {worktreeRows.length > 0 ? (
          <ol className="flex flex-col border-b border-border/60 py-1">
            {worktreeRows.map((row) => (
              // Naming the worktree only matters once more than one has changes.
              <WorktreeChangeRow key={row.key} row={row} showWorktree={hasMultipleWorktrees} />
            ))}
          </ol>
        ) : null}
        <ol className="flex flex-col py-1">
          {layout.rows.map((row, index) => {
            const commit = snapshot.commits[index]!;
            const { visible: visibleRefs, overflowCount } = splitVisibleGraphRefs(
              refsByOid.get(commit.oid) ?? [],
            );
            return (
              <li
                key={commit.oid}
                className="flex items-center gap-2 px-3 hover:bg-accent/50"
                style={{ height: GIT_GRAPH_ROW_HEIGHT }}
              >
                <GitGraphRowGlyph row={row} columnCount={layout.columnCount} />
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  {visibleRefs.length > 0 || overflowCount > 0 ? (
                    // Capped as a group so chips and summary each keep a share
                    // of a narrow row instead of one starving the other.
                    <span className="flex max-w-[55%] shrink-0 items-center gap-1 overflow-hidden">
                      {visibleRefs.map((graphRef) => (
                        <RefChip key={`${graphRef.kind}:${graphRef.name}`} graphRef={graphRef} />
                      ))}
                      {overflowCount > 0 ? (
                        <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                          +{overflowCount}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {commit.summary.length > 0 ? (
                      commit.summary
                    ) : (
                      <span className="text-muted-foreground italic">no commit message</span>
                    )}
                  </span>
                </div>
                {/* The author is the first thing worth dropping when the panel
                    is narrow; the summary is what people scan for. */}
                <span className="hidden max-w-[7rem] shrink-0 truncate text-[11px] text-muted-foreground @md:block">
                  {commit.authorName}
                </span>
                <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {formatCommitAge(DateTime.toEpochMillis(commit.committedAt), nowMs)}
                </span>
                <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {shortOid(commit.oid)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  };

  return (
    // A container, not a media, query: the panel is user-resizable, so row
    // density has to respond to the panel's own width, not the viewport's.
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      {header}
      {body()}
    </div>
  );
}

/**
 * A synthetic row for uncommitted work. It deliberately does not draw into the
 * lane graph: a worktree's HEAD can be any commit on the page, so a connector
 * would have to thread arbitrarily far down. The hollow marker plus the divider
 * below the block carry the "above HEAD" relationship instead.
 */
function WorktreeChangeRow(props: { row: GitGraphWorktreeRow; showWorktree: boolean }) {
  const { row, showWorktree } = props;
  const detail = [
    row.conflictedFileCount > 0 ? `${row.conflictedFileCount} conflicted` : null,
    row.untrackedFileCount > 0 ? `${row.untrackedFileCount} untracked` : null,
  ].filter((entry) => entry !== null);

  return (
    <li
      className="flex items-center gap-2 px-3 hover:bg-accent/50"
      style={{ height: GIT_GRAPH_ROW_HEIGHT }}
    >
      <span
        className="flex shrink-0 items-center justify-center"
        style={{ width: GIT_GRAPH_LANE_WIDTH }}
        aria-hidden="true"
      >
        <span
          className={cn(
            "size-1.5 rounded-full border",
            row.kind === "staged"
              ? "border-success bg-success/40"
              : "border-muted-foreground bg-transparent",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span className="shrink-0 text-xs font-medium">
          {row.kind === "staged" ? "Staged changes" : "Uncommitted changes"}
        </span>
        {showWorktree ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {row.isActiveWorktree ? `${row.label} · this thread` : row.label}
          </span>
        ) : null}
        {detail.length > 0 ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">({detail.join(", ")})</span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {row.fileCount} {row.fileCount === 1 ? "file" : "files"}
      </span>
    </li>
  );
}

function EmptyState(props: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <p className="text-center text-sm text-muted-foreground">{props.message}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2 p-3"
      role="status"
      aria-label="Loading history"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-2">
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 flex-1 rounded-full" />
          <Skeleton className="h-3 w-10 rounded-full" />
        </div>
      ))}
      <span className="sr-only">Loading history</span>
    </div>
  );
}

export default GitGraphPanel;
