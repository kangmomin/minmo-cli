import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// 워크스페이스 패키지(@minmo/*)는 private·소스 전용이라 번들에 넣고,
// ink·react·commander 는 일반 dependencies 로 설치되게 둔다(tgz 설치 시 npm 이 받는다).
export default defineConfig({
  entry: { minmo: 'src/main.tsx' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  noExternal: [/^@minmo\//],
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
})
