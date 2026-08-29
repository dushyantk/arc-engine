// Loads `.env` exactly the way `next build` / `next start` do, so the test
// process talks to the same Postgres, MinIO and ClickHouse the app under test
// talks to — there is no second source of connection strings to drift from.
//
// Imported for its side effect, and always *above* anything that reads
// process.env at module scope. ESM evaluates imports in declaration order, so
// keeping this first is what makes the ordering guarantee real rather than
// incidental.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, {
  info: () => {},
  error: (...args: unknown[]) => console.error(...args),
});

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The e2e suite runs against the local docker-compose stack; ` +
        `check that .env exists at the repo root.`,
    );
  }
  return value;
}
