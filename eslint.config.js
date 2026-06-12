import nextPlugin from '@next/eslint-plugin-next';

export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/generated/**',
      'coverage/**',
      'next-env.d.ts',
    ],
  },
  nextPlugin.configs['core-web-vitals'],
];
