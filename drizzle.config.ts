import { defineConfig } from 'drizzle-kit'

const migrationUrl = process.env.DATABASE_MIGRATION_URL
if (process.argv.includes('migrate') && !migrationUrl) {
  throw new Error('DATABASE_MIGRATION_URL is required to run migrations')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: migrationUrl ?? 'postgresql://axiom:axiom@127.0.0.1:55432/axiom_lumen',
  },
  migrations: {
    table: '__axiom_lumen_migrations',
    schema: 'drizzle',
  },
  strict: true,
  verbose: true,
})
