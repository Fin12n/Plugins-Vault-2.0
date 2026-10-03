import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  const possiblePaths = [
    resolve(process.cwd(), "../../discord/.env"),
    resolve(process.cwd(), "../discord/.env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const envPath of possiblePaths) {
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      if (process.env.DATABASE_URL) break;
    }
  }
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});

