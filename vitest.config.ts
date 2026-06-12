import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // `server-only` is a Next.js runtime guard with no resolvable package
      // on disk; stub it out so server-side modules can be imported under
      // vitest's plain-node environment.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Only count source we actually intend to cover. Generated Prisma
      // client, the archive viewer (its own project), and Next-internal
      // files would skew the percentages without telling us anything we
      // could act on.
      include: ['src/lib/**/*.ts', 'src/server/**/*.ts'],
      exclude: ['src/generated/**', '**/*.d.ts', '**/*.test.ts'],
      // Block PRs that regress coverage. Single 80% floor across every
      // axis — simple to communicate, gives ~10% headroom against the
      // current ~92% baseline, and gets pushed up as coverage grows.
      // Don't drop these.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
