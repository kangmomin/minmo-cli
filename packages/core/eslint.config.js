import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// 데스크탑·원격 CLI 공용 도메인 코드 — 브라우저·Node 어느 쪽 전역에도 기대지 않는다
export default tseslint.config({
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  files: ['**/*.ts'],
  languageOptions: { ecmaVersion: 2022, globals: { ...globals.es2021 } },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
})
