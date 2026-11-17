import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// 원격 CLI(Node) — 데스크탑과 같은 규칙에 node 전역을 쓴다
export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts'],
    languageOptions: { ecmaVersion: 2023, globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
