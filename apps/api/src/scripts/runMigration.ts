import { Client } from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Load the migration env file
dotenv.config({ path: path.join(__dirname, "../../../../.env.migration") });

const databaseUrl = process.env.TARGET_DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ TARGET_DATABASE_URL not found in .env.migration");
  process.exit(1);
}

const sqlPath = path.join(__dirname, "../../sql/dustsweep_schema.sql");

async function runMigration() {
  const client = new Client({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    console.log("⏳ Connecting to Railway database...");
    await client.connect();
    console.log("✅ Connected.");

    console.log(`📖 Reading SQL from ${sqlPath}...`);
    const sql = fs.readFileSync(sqlPath, "utf8");

    console.log("🚀 Executing migration...");
    // Split by semicolon to run multiple statements if needed, 
    // but pg client can often run a block. 
    // However, some complex blocks might need splitting.
    // For this schema, running the whole block usually works.
    await client.query(sql);

    console.log("✅ Migration completed successfully!");
  } catch (err) {
    console.error("❌ Migration failed:");
    console.error(err);
  } finally {
    await client.end();
  }
}

runMigration();
