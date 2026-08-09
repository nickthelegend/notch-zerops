import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit and integration tests live in test/ and nowhere else. Vitest's default glob reaches
    // the whole tree, which is how a standalone ffmpeg checker under scripts/ ended up in the
    // suite and turned it red.
    include: ['test/**/*.test.ts'],
    // Redirects DATABASE_URL to a dedicated test database before any module is imported, so
    // the integration suites cannot append fixtures to the log the app demos from. See the
    // file's own comment for how it found that problem.
    setupFiles: ['./test/helpers/testdb.ts'],
  },
});
