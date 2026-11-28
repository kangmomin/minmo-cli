// 지운 기능(E2E 큐, #92)이 작업 폴더에 남긴 결과 폴더(.minmo/e2e)를 정리한다(#111).
// 작업 폴더가 열릴 때(ready) 그 폴더의 호스트에서 창마다 한 번 지운다. 실패는 알리지 않는다 — 앱을 다시 시작한 뒤(또는 새 창에서) 열면 다시 시도한다.
import { useEffect } from 'react'

import { aliasOfIssue, hostOf, useHostDeps } from '../../app/host'
import { isDefaultIssueId } from '../../lib/defaultWorkspace'
import type { TauriApi } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'

type CleanupOps = Pick<TauriApi, 'listDir' | 'pathExists' | 'removePath'>

/**
 * .minmo/e2e 를 지우고, .minmo 가 정말 비었으면 .minmo 도 지운다.
 * 확인(목록·.git)이 실패하거나 .minmo 가 링크면 지우지 않는 쪽으로 끝낸다 — 사용자 파일을 잃지 않게
 */
export async function cleanupLegacyE2e(ops: CleanupOps, path: string): Promise<void> {
  try {
    // 링크면 로컬은 대상 폴더를 따라가 지울 수 있다 — 폴더일 때만
    const root = await ops.listDir(path, '')
    if (!root.some((e) => e.name === '.minmo' && e.kind === 'dir')) return
    await ops.removePath(path, '.minmo/e2e').catch(() => undefined)
    if ((await ops.listDir(path, '.minmo')).length > 0) return
    // listDir 는 .git 을 목록에서 빼므로 따로 확인한다
    if (await ops.pathExists(`${path}/.minmo/.git`)) return
    await ops.removePath(path, '.minmo')
  } catch {
    // 읽는 곳이 없는 폴더다 — 남아도 동작에 영향이 없다
  }
}

/** 이 창에서 이미 정리를 시도한 (호스트, 작업 폴더) */
const tried = new Set<string>()

/** 테스트용 — 시도 기록을 비운다 */
export function resetLegacyE2eCleanup() {
  tried.clear()
}

/** 앱 전역 훅(Workspace 에서 한 번) — 열린 작업 폴더마다 창 하나에서 한 번 정리한다 */
export function useLegacyE2eCleanup() {
  const hostDeps = useHostDeps()
  useEffect(() => {
    const scan = () => {
      // probe 확인과 deps 선택을 같은 동기 구간에서 한다(그 사이 probe 가 바뀌지 않는다) — probe 가 없는 원격 이슈에 hostDeps 는 이 PC 를 돌려준다
      const probes = useHostsStore.getState().probes
      for (const [id, o] of Object.entries(useSetupStore.getState().open)) {
        // Why: 기본의 작업 폴더는 그 호스트의 홈이다 — 홈의 .minmo 는 지운 기능의 결과 폴더가 아니다
        if (o.phase !== 'ready' || isDefaultIssueId(id)) continue
        const alias = aliasOfIssue(id)
        if (alias !== null && !probes[alias]) continue
        const key = `${alias ?? ''}\n${o.path}`
        if (tried.has(key)) continue
        // 기다리기 전에 표시한다 — 곧이어 오는 변경이 같은 폴더를 두 번 지우지 않게
        tried.add(key)
        void cleanupLegacyE2e(hostDeps(hostOf(alias)).tauri, o.path)
      }
    }
    scan()
    const stopOpen = useSetupStore.subscribe((s, prev) => {
      if (s.open !== prev.open) scan()
    })
    const stopProbes = useHostsStore.subscribe((s, prev) => {
      if (s.probes !== prev.probes) scan()
    })
    return () => {
      stopOpen()
      stopProbes()
    }
  }, [hostDeps])
}
