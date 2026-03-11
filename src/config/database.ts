import "dotenv/config";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "okc_calls",
  user: process.env.DB_USER || "okc_user",
  password: process.env.DB_PASSWORD || "okc_password",
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
