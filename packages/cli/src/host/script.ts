// 생성 후 스크립트 실행기 — 데스크탑 Rust script.rs 와 같은 동작:
// - Linux·macOS: 임시 파일에 `set -e` 를 붙여 sh 로, 별도 프로세스 그룹, 취소는 SIGTERM → 3초 뒤 SIGKILL
// - Windows: BOM 붙은 .ps1 을 powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 로, 취소는 taskkill /T /F
// 출력은 줄 단위로 내보낸다.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { ScriptHost, ScriptLogEvent, ScriptRunRequest, ScriptRunResult } from '@minmo/core'

import { taskkillTree } from './win'

const safeName = (runId: string) => runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'run'

/** Windows PowerShell 5.1 이 UTF-8 로 읽도록 BOM, 첫 오류에서 멈추고, 마지막 네이티브 명령의 종료 코드를 넘긴다 */
export function powershellScript(script: string): Buffer {
  const body =
    "$ErrorActionPreference = 'Stop'\r\n" +
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n' +
    '$OutputEncoding = [System.Text.Encoding]::UTF8\r\n' +
    `${script.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')}\r\n` +
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }\r\n'
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])
}

type Flavor = { ext: string; content(script: string): string | Buffer; command(file: string): [string, string[]]; kill(pid: number): void; group: boolean }

const POSIX: Flavor = {
  ext: 'sh',
  content: (script) => `set -e\n${script.replace(/\r\n/g, '\n')}\n`,
  command: (file) => ['sh', [file]],
  kill: (pid) => {
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig)
      } catch {
        // 이미 끝남
      }
    }
    group('SIGTERM')
    setTimeout(() => group('SIGKILL'), 3000).unref()
  },
  // 취소 시 자식까지 한 번에 끝내도록 새 프로세스 그룹
  group: true,
}

const WINDOWS: Flavor = {
  ext: 'ps1',
  content: powershellScript,
  command: (file) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]],
  kill: (pid) => void taskkillTree(pid),
  // Windows 의 detached 는 새 콘솔 창을 띄운다 — 트리 종료는 taskkill /T 가 맡는다
  group: false,
}

export function createScriptHost(platform: NodeJS.Platform = process.platform): ScriptHost {
  const flavor = platform === 'win32' ? WINDOWS : POSIX
  const running = new Map<string, number>()
  const cancelled = new Set<string>()
  const listeners = new Set<(e: ScriptLogEvent) => void>()

  return {
    async scriptRun(req: ScriptRunRequest): Promise<ScriptRunResult> {
      if (cancelled.delete(req.runId)) return { exitCode: null, cancelled: true }
      // 실행마다 전용 폴더(0700)·파일(0600) — 공용 임시 폴더의 고정 이름은 다른 사용자가 먼저 만들어 스크립트를 바꿔치기할 수 있다
      const dir = await mkdtemp(join(tmpdir(), 'minmo-script-'))
      const file = join(dir, `${safeName(req.runId)}.${flavor.ext}`)
      try {
        await writeFile(file, flavor.content(req.script), { mode: 0o600 })
        // 파일을 쓰는 사이 취소됐으면 실행하지 않는다
        if (cancelled.delete(req.runId)) return { exitCode: null, cancelled: true }
        const [cmd, args] = flavor.command(file)
        return await new Promise<ScriptRunResult>((resolve, reject) => {
          const child = spawn(cmd, args, {
            cwd: req.cwd,
            env: { ...process.env, ...req.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: flavor.group,
            windowsHide: true,
          })
          if (child.pid !== undefined) running.set(req.runId, child.pid)
          const pump = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') =>
            createInterface({ input: stream }).on('line', (line) => {
              for (const l of listeners) l({ runId: req.runId, stream: name, line })
            })
          pump(child.stdout, 'stdout')
          pump(child.stderr, 'stderr')
          child.on('error', (e) => {
            running.delete(req.runId)
            reject(e)
          })
          child.on('close', (code) => {
            running.delete(req.runId)
            if (cancelled.delete(req.runId)) resolve({ exitCode: null, cancelled: true })
            else resolve({ exitCode: code ?? -1, cancelled: false })
          })
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },

    async scriptCancel(runId: string) {
      cancelled.add(runId)
      const pid = running.get(runId)
      if (pid !== undefined) flavor.kill(pid)
    },

    async onScriptLog(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
