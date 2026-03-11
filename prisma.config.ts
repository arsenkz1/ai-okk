import { defineConfig } from "prisma/config";

// Prisma 7 config: указываем прямой PostgreSQL, поднятый в Docker.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: "postgresql://okc_user:okc_password@localhost:5433/okc_calls",
  },
});
