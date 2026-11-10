// 생성 후 스크립트(sh) 실행기 — 데스크탑 Rust script.rs 의 비Windows 동작과 같다:
// 임시 파일에 `set -e` 를 붙여 sh 로 실행, 별도 프로세스 그룹, 줄 단위 출력, 취소는 SIGTERM → 3초 뒤 SIGKILL.
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { ScriptHost, ScriptLogEvent, ScriptRunRequest, ScriptRunResult } from '@minmo/core'

const safeName = (runId: string) => runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'run'

export function createScriptHost(): ScriptHost {
  const running = new Map<string, number>()
  const cancelled = new Set<string>()
  const listeners = new Set<(e: ScriptLogEvent) => void>()

  function killGroup(pid: number, sig: NodeJS.Signals) {
    try {
      process.kill(-pid, sig)
    } catch {
      // 이미 끝남
    }
  }

  return {
    async scriptRun(req: ScriptRunRequest): Promise<ScriptRunResult> {
      if (cancelled.delete(req.runId)) return { exitCode: null, cancelled: true }
      const dir = join(tmpdir(), 'minmo-scripts')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${safeName(req.runId)}.sh`)
      await writeFile(file, `set -e\n${req.script.replace(/\r\n/g, '\n')}\n`)
      try {
        return await new Promise<ScriptRunResult>((resolve, reject) => {
          const child = spawn('sh', [file], {
            cwd: req.cwd,
            env: { ...process.env, ...req.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            // 취소 시 자식까지 한 번에 끝내도록 새 프로세스 그룹
            detached: true,
          })
          if (child.pid !== undefined) running.set(req.runId, child.pid)
          const pump = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') =>
            createInterface({ input: stream }).on('line', (line) => {
              for (const l of listeners) l({ runId: req.runId, stream: name, line })
            })
          pump(child.stdout, 'stdout')
          pump(child.stderr, 'stderr')
          child.on('error', reject)
          child.on('close', (code) => {
            running.delete(req.runId)
            if (cancelled.delete(req.runId)) resolve({ exitCode: null, cancelled: true })
            else resolve({ exitCode: code ?? -1, cancelled: false })
          })
        })
      } finally {
        await rm(file, { force: true })
      }
    },

    async scriptCancel(runId: string) {
      cancelled.add(runId)
      const pid = running.get(runId)
      if (pid === undefined) return
      killGroup(pid, 'SIGTERM')
      setTimeout(() => killGroup(pid, 'SIGKILL'), 3000).unref()
    },

    async onScriptLog(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
