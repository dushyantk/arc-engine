import "./env";
import {
  closeTestDb,
  destroyAllE2EShows,
  destroyE2EOperator,
  E2E_SHOW_PREFIX,
} from "./fixtures";

// Safety net for a crashed or interrupted run: per-test teardown is the normal
// path, this is what guarantees nothing is left behind when that path never
// runs. Only ever reaches shows named with the fixture prefix.
export default async function globalTeardown(): Promise<void> {
  try {
    const removed = await destroyAllE2EShows();
    if (removed > 0) {
      console.log(
        `[e2e] global teardown removed ${removed} leftover "${E2E_SHOW_PREFIX}…" show(s)`,
      );
    }
    // The suite's own operator goes too - it exists only to hold a session for
    // these tests, and leaving it behind would leave a usable local login.
    await destroyE2EOperator();
  } finally {
    await closeTestDb();
  }
}
