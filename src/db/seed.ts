import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./pool";

// Loads the users (id and role) from the threads file. Threads themselves go in through POST /ingest.
async function seed(file = path.resolve("data/threads.json")) {
  const { users } = JSON.parse(await readFile(file, "utf8")) as { users: { id: string; role: string }[] };
  for (const user of users) {
    await pool.query(
      "INSERT INTO users (id, role) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role",
      [user.id, user.role],
    );
  }
  console.log(`Seeded ${users.length} users`);
}

seed(process.argv[2])
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
