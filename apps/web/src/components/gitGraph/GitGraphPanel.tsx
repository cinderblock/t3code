import type { EnvironmentId, VcsGraphRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { TagIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { layoutGitGraph } from "~/lib/gitGraphLayout";
import { cn } from "~/lib/utils";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FILE_SURFACE_SUBHEADER_CLASS } from "../files/fileSurfaceChrome";
import { Skeleton } from "../ui/skeleton";
import { GitGraphRowGlyph, GIT_GRAPH_LANE_WIDTH, GIT_GRAPH_ROW_HEIGHT } from "./GitGraphRowGlyph";
import {
  buildWorktreeRows,
  formatCommitAge,
  groupGraphRefsByOid,
  remoteLabelColor,
  shortOid,
  splitVisibleGraphRefs,
  type GitGraphWorktreeRow,
} from "./gitGraphPresentation";

/** Remote refs are tinted per remote, so `origin/main` and `upstream/main` differ at a glance. */
function RefChip(props: { item: VcsGraphRef }) {
  const { item } = props;
  const remoteColor =
    item.kind === "remote" && item.remoteName !== null && !item.current
      ? remoteLabelColor(item.remoteName)
      : null;

  return (
    <Badge
      size="sm"
      variant={
        item.current
          ? "info"
          : remoteColor
            ? "label"
            : item.kind === "tag"
              ? "outline"
              : "secondary"
      }
      className="min-w-0 max-w-[9rem] shrink justify-start"
      {...(remoteColor ? { style: { "--label": remoteColor } as CSSProperties } : {})}
    >
      {item.kind === "tag" ? <TagIcon aria-hidden /> : null}
      <span className="truncate">{item.name}</span>
    </Badge>
  );
}

function GitGraphPanel(props: {
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
  const worktreePaths = (snapshot?.worktrees ?? []).map((worktree) => worktree.path).toSorted();
  const worktreeChangesQuery = useEnvironmentQuery(
    cwd === null || worktreePaths.length === 0
      ? null
      : vcsEnvironment.worktreeChanges({ environmentId, input: { cwd, worktreePaths } }),
  );
  const worktreeRows = buildWorktreeRows({
    worktrees: snapshot?.worktrees ?? [],
    changes: worktreeChangesQuery.data?.worktrees ?? [],
    activeWorktreePath,
  });

  const hasMultipleWorktrees = new Set(worktreeRows.map((row) => row.worktreePath)).size > 1;

  const layout = layoutGitGraph(snapshot?.commits ?? []);
  const refsByOid = groupGraphRefsByOid(snapshot?.refs ?? []);
  // One instant for every row, so ages on screen agree.
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);

  const header = (
    <div className={cn(FILE_SURFACE_SUBHEADER_CLASS, "justify-between")} data-surface-subheader>
      <span className="truncate text-sm font-medium">History</span>
      <div className="flex shrink-0 items-center gap-2">
        {snapshot ? (
          <span className="text-xs text-muted-foreground">
            {snapshot.commits.length}
            {snapshot.nextCursor === null ? "" : "+"} commits
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={snapshotQuery.refresh}
                disabled={cwd === null}
                aria-label="Refresh history"
              />
            }
          >
            <RefreshIcon refreshing={snapshotQuery.isPending} />
          </TooltipTrigger>
          <TooltipPopup>{snapshotQuery.isPending ? "Refreshing…" : "Refresh history"}</TooltipPopup>
        </Tooltip>
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
                      {visibleRefs.map((item) => (
                        <RefChip key={`${item.kind}:${item.name}`} item={item} />
                      ))}
                      {overflowCount > 0 ? (
                        <Badge size="sm" variant="outline">
                          +{overflowCount}
                        </Badge>
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
                <span className="hidden max-w-[7rem] shrink-0 truncate text-2xs text-muted-foreground @md:block">
                  {commit.authorName}
                </span>
                <span className="w-9 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                  {formatCommitAge(DateTime.toEpochMillis(commit.committedAt), nowMs)}
                </span>
                <span className="w-14 shrink-0 text-right font-mono text-2xs text-muted-foreground">
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
          <span className="min-w-0 truncate text-2xs text-muted-foreground">
            {row.isActiveWorktree ? `${row.label} · this thread` : row.label}
          </span>
        ) : null}
        {detail.length > 0 ? (
          <span className="shrink-0 text-2xs text-muted-foreground">({detail.join(", ")})</span>
        ) : null}
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
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
          <Skeleton shape="pill" className="size-3" />
          <Skeleton shape="pill" className="h-3 flex-1" />
          <Skeleton shape="pill" className="h-3 w-10" />
        </div>
      ))}
      <span className="sr-only">Loading history</span>
    </div>
  );
}

export default GitGraphPanel;
