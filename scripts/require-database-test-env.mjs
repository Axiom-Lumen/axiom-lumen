if (!process.env.DATABASE_TEST_ADMIN_URL) {
  throw new Error('DATABASE_TEST_ADMIN_URL is required for the CI database test stage')
}
