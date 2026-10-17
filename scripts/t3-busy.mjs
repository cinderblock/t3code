// Prints the T3 Code work that a restart would cut off, as a JSON array:
// runs queued or in progress and requests waiting on the user, across every
// project. Opens the live database read-only; the app keeps it in WAL mode, so
// a reader neither blocks it nor changes anything.
//
//   node scripts/t3-busy.mjs <path to statev2.sqlite>
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const runs = db
  .prepare(
    `SELECT r.status, t.title
     FROM orchestration_v2_projection_runs r
     JOIN orchestration_v2_projection_threads t USING (thread_id)
     WHERE r.status IN ('queued', 'starting', 'preparing', 'running', 'waiting')`,
  )
  .all();
const requests = db
  .prepare(
    `SELECT q.kind AS status, t.title
     FROM orchestration_v2_projection_runtime_requests q
     JOIN orchestration_v2_projection_threads t USING (thread_id)
     WHERE q.status = 'pending'`,
  )
  .all();
console.log(JSON.stringify([...runs, ...requests]));
