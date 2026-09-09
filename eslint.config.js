// Lint contract: strict TypeScript and public-package quality rules.
// Type-checked rules are load-bearing for an async disposal engine
// (no-floating-promises / no-misused-promises); the bans on `any` and
// non-null assertions are ground rule 4 of the implementation plan.
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.stryker-tmp/**',
      '**/reports/**',
      'pnpm-lock.yaml',
    ],
  },
  {
    // Root-level TypeScript configs (no package tsconfig owns them).
    files: ['*.ts'],
    extends: [tseslint.configs.recommended],
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    // Everything under a workspace package: full type-checked linting via the
    // nearest tsconfig (projectService).
    files: ['packages/**/*.ts', 'examples/**/*.ts', 'demo/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    plugins: { 'simple-import-sort': simpleImportSort },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    // Plain JS config files at the root: parsed, not type-checked.
    files: ['*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
