// In-process CPU profiling: `NODE_OPTIONS=--cpu-prof` never reaches this backend (Electron
// strips it for children). `T3_CPU_PROF_DIR` enables it (unset costs nothing);
// `T3_CPU_PROF_SECONDS` sets how long from startup to profile (default 90).

// node:inspector needs no diagnostics suppression -- it has no Effect
// equivalent, so the rule does not flag it (adding one is itself a warning).
import * as NodeInspector from "node:inspector";
// @effect-diagnostics-next-line nodeBuiltinImport:off - one-shot diagnostic write, outside the app's FileSystem layer
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - path join for the same one-shot write
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const DEFAULT_SECONDS = 90;

function resolveSeconds(): number {
  const raw = process.env.T3_CPU_PROF_SECONDS?.trim();
  if (!raw) return DEFAULT_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SECONDS;
}

/**
 * `session.post` is callback-based. Effect 4 spells the callback adapter
 * `Effect.callback` — `Effect.async` does not exist here, and using it yields
 * `unknown`, which silently poisons the requirements channel of every layer
 * downstream (it surfaced as ~60 errors in bin.test.ts, not in this file).
 */
const post = (session: NodeInspector.Session, method: string) =>
  Effect.callback<unknown, Error>((resume) => {
    session.post(method, (error: Error | null, result: unknown) => {
      resume(error ? Effect.fail(error) : Effect.succeed(result));
    });
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const dir = (yield* Config.String("T3_CPU_PROF_DIR").pipe(Config.withDefault(""))).trim();
    if (!dir) {
      return;
    }

    const seconds = resolveSeconds();
    const session = new NodeInspector.Session();
    session.connect();

    yield* post(session, "Profiler.enable");
    yield* post(session, "Profiler.start");
    yield* Effect.logInfo("CPU profiler started").pipe(
      Effect.annotateLogs({ dir, seconds, pid: process.pid }),
    );

    // Forked so startup is not held up by the profiling window.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.seconds(seconds));
        const result = (yield* post(session, "Profiler.stop")) as { readonly profile: unknown };
        const file = NodePath.join(dir, `server-${process.pid}-startup.cpuprofile`);
        yield* Effect.promise(() =>
          NodeFSP.mkdir(dir, { recursive: true }).then(() =>
            NodeFSP.writeFile(file, JSON.stringify(result.profile)),
          ),
        );
        session.disconnect();
        yield* Effect.logInfo("CPU profile written").pipe(Effect.annotateLogs({ file, seconds }));
      }),
    );
  }).pipe(
    // A diagnostic must never fail the server, nor leak its error type into
    // the server layer's error channel — doing so propagates all the way out
    // to `makeServerLayer` and breaks every caller's types.
    Effect.catchCause((cause) =>
      Effect.logWarning("CPU profiling unavailable").pipe(Effect.annotateLogs({ cause })),
    ),
  ),
);
