/**
 * Vitest setupFiles entry for integration tests.
 * Runs inside each worker before any test file is executed.
 * Loads .env.integration with override:true so changes to the file
 * are always picked up without any manual shell sourcing.
 */
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

config({ path: path.join(repoRoot, ".env.integration"), override: true });
