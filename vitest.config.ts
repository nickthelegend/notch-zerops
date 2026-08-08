import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Redirects DATABASE_URL to a dedicated test database before any module is imported, so
    // the integration suites cannot append fixtures to the log the app demos from. See the
    // file's own comment for how it found that problem.
    setupFiles: ['./test/helpers/testdb.ts'],
  },
});
