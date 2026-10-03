/** Applies pending memefun_app migrations: `pnpm migrate`. */
import { createAppPool } from "../lib/db";
import { loadLocalEnv } from "../lib/env";
import { migrate } from "../lib/migrate";

loadLocalEnv();
const pool = createAppPool({ max: 1 });
try {
  const applied = await migrate(pool);
  console.log(applied.length > 0 ? `applied ${applied.join(", ")}` : "memefun_app is up to date");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
