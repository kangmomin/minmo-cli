// 원격 호스트(SSH 프로필)용 호스트 구현 — worktree 서비스(@minmo/core)가 쓰는 git·파일·스크립트 작업을
// `ssh <별칭> …` 으로 원격에서 실행한다. 원격은 POSIX(Linux·macOS)만 지원한다.
import type { CmdResult, RunOptions } from '@minmo/core'

import type { RemotePty, SshError, SshErrorKind, SshProbe, TauriApi } from './tauri'

/** 호스트에 따라 달라지는 작업만 원격 구현으로 바꾼 TauriApi 의 일부 */
export type HostOps = Pick<
  TauriApi,
  | 'gitRun'
  | 'pathExists'
  | 'removeDir'
  | 'copyTree'
  | 'listFiles'
  | 'copyFileInto'
  | 'removeFileIn'
  | 'openDir'
  | 'scriptRun'
  | 'scriptCancel'
  | 'ptyKillByCwd'
  | 'homeDir'
  | 'platform'
>

/** 덮어쓰지 않고, 심볼릭 링크는 따라가지 않는다(로컬 copy_tree 와 같은 규칙). 복사한 개수를 출력한다 */
const COPY_TREE = `src=$1; dst=$2
[ -d "$src" ] || { echo 0; exit 0; }
cd -- "$src" || exit 1
find . -type f -print | {
  n=0
  while IFS= read -r f; do
    t="$dst/\${f#./}"
    if [ -e "$t" ] || [ -L "$t" ]; then continue; fi
    mkdir -p -- "$(dirname -- "$t")" && cp -p -- "$f" "$t" && n=$((n+1))
  done
  echo "$n"
}`

const LIST_FILES = `[ -d "$1" ] || exit 0
cd -- "$1" || exit 1
find . -type f -print | sed 's|^\\./||' | LC_ALL=C sort`

const COPY_FILE = `s="$1/$2"; t="$3/$2"
if [ -L "$s" ]; then echo "심볼릭 링크는 보관할 수 없습니다: $2" >&2; exit 1; fi
if [ ! -f "$s" ]; then echo "파일이 없습니다: $2" >&2; exit 1; fi
mkdir -p -- "$(dirname -- "$t")" && cp -p -- "$s" "$t"`

/**
 * worktree 의 전용 tmux 세션을 끝낸다 — 세션 안의 프로세스는 SIGHUP 을 받는다.
 * 이름($2, 분할 패널은 -pN)과 태그(하위 경로 포함) 둘 다로 찾는다. 원격 로케일이 UTF-8 이 아니면 tmux 가
 * 출력의 한글 경로를 '_' 로 바꾸므로 -u 로 UTF-8 출력을 강제한다.
 */
const KILL_TMUX = `p=\${1%/}; n=$2
tmux -u -L minmo list-sessions -F '#{session_name}|#{@minmo_worktree}' 2>/dev/null | while IFS='|' read -r name wt; do
  case "$name" in "$n"|"$n"-p*) tmux -L minmo kill-session -t "=$name"; continue ;; esac
  case "$wt" in "$p"|"$p"/*) tmux -L minmo kill-session -t "=$name" ;; esac
done
exit 0`

const SSH_KINDS: SshErrorKind[] = ['host_key', 'auth', 'unreachable', 'unsupported_os', 'no_git', 'unknown_host', 'failed']

/** sshProbe 의 reject 값({kind, message})이나 "ssh(kind): message" 문자열을 SshError 로 */
export function sshErrorOf(e: unknown): SshError {
  if (typeof e === 'object' && e !== null && 'kind' in e && 'message' in e) {
    const { kind, message } = e as { kind: unknown; message: unknown }
    if (SSH_KINDS.includes(kind as SshErrorKind)) return { kind: kind as SshErrorKind, message: String(message) }
  }
  const text = e instanceof Error ? e.message : String(e)
  const m = /^ssh\((\w+)\): ([\s\S]*)$/.exec(text)
  if (m && SSH_KINDS.includes(m[1] as SshErrorKind)) return { kind: m[1] as SshErrorKind, message: m[2] }
  return { kind: 'failed', message: text }
}

/** 원인별 안내 — 사용자가 다음에 할 일을 알려 준다 */
export function sshErrorText(alias: string, e: SshError): string {
  switch (e.kind) {
    case 'host_key':
      return `호스트 키를 확인할 수 없습니다 — 터미널에서 \`ssh ${alias}\` 로 한 번 접속해 호스트 키를 등록하세요.`
    case 'auth':
      return `인증에 실패했습니다 — 키 또는 ssh-agent 를 설정하세요(비밀번호 입력 방식은 지원하지 않습니다). \`ssh ${alias}\` 가 묻지 않고 접속되어야 합니다.`
    case 'unreachable':
      return `호스트에 연결할 수 없습니다 — 네트워크·VPN·주소를 확인하세요. (${e.message})`
    case 'unsupported_os':
      return `지원하지 않는 원격 OS 입니다 — Linux·macOS 만 지원합니다. (${e.message})`
    case 'no_git':
      return '원격에 git 이 없습니다 — git 을 설치한 뒤 다시 시도하세요.'
    case 'unknown_host':
      return `~/.ssh/config 에 ${alias} 호스트가 없습니다.`
    default:
      return `ssh 연결 실패: ${e.message}`
  }
}

/** 로컬 remove_dir(fs.rs)와 같은 안전 조건 — 얕은 경로·홈·`..` 는 지우지 않는다 */
export function assertRemovable(path: string, home: string): void {
  const parts = path.split('/').filter(Boolean)
  const trimmed = `/${parts.join('/')}`
  if (!path.startsWith('/') || parts.includes('..') || parts.includes('.') || parts.length < 3 || trimmed === home.replace(/\/+$/, '')) {
    throw new Error(`지울 수 없는 경로입니다: ${path}`)
  }
}

/** 보관 파일의 상대 경로 — 폴더 밖을 가리키지 못하게 한다 */
export function assertRelative(rel: string): void {
  const parts = rel.split('/')
  if (rel === '' || rel.startsWith('/') || rel.includes('\\') || rel.includes('\n') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`상대 경로가 올바르지 않습니다: ${rel}`)
  }
}

export function createSshOps(base: TauriApi, alias: string, probe: SshProbe): HostOps {
  const exec = (argv: string[], opts?: RunOptions & { stdin?: string }) => base.sshExec(alias, argv, opts)
  const script = (body: string, args: string[]) => exec(['sh', '-s', '--', ...args], { stdin: body })
  const must = (r: CmdResult, what: string): CmdResult => {
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${what} 실패(종료 코드 ${r.code})`)
    return r
  }
  return {
    // 원격 git 이 자격 증명을 물으며 멈추지 않게(실패로 끝나게) 한다
    gitRun: (args, opts) => exec(['git', ...args], { cwd: opts?.cwd, env: { GIT_TERMINAL_PROMPT: '0', ...opts?.env } }),
    pathExists: async (path) => (await exec(['test', '-e', path])).code === 0,
    removeDir: async (path) => {
      assertRemovable(path, probe.home)
      must(await exec(['rm', '-rf', '--', path]), '폴더 삭제')
    },
    copyTree: async (src, dst) => Number(must(await script(COPY_TREE, [src, dst]), '파일 복사').stdout.trim()) || 0,
    listFiles: async (root) =>
      must(await script(LIST_FILES, [root]), '파일 목록')
        .stdout.split('\n')
        .filter((l) => l !== ''),
    copyFileInto: async (srcRoot, rel, dstRoot) => {
      assertRelative(rel)
      must(await script(COPY_FILE, [srcRoot, rel, dstRoot]), '파일 보관')
    },
    removeFileIn: async (root, rel) => {
      assertRelative(rel)
      must(await exec(['rm', '-f', '--', `${root}/${rel}`]), '파일 삭제')
    },
    openDir: async () => {
      throw new Error('원격 폴더는 이 PC 의 탐색기로 열 수 없습니다')
    },
    scriptRun: (req) => base.sshScriptRun(alias, req),
    scriptCancel: (runId) => base.sshScriptCancel(runId),
    ptyKillByCwd: async (path) => {
      const local = await base.ptyKillByCwd(path, alias)
      if (probe.tmux) await script(KILL_TMUX, [path, tmuxSessionName(path)])
      return local
    },
    homeDir: async () => probe.home,
    platform: async () => probe.platform,
  }
}

/** SHA-1(hex). tmux 세션 이름을 원격 CLI 와 맞추는 데만 쓴다(보안 용도 아님) */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const len = bytes.length
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000))
  view.setUint32(padded.length - 4, (len * 8) >>> 0)
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Uint32Array(80)
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let [a, b, c, d, e] = h
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6]
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = t
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** 원격 CLI(packages/cli/src/host/tmux.ts sessionName)와 같은 이름 — `minmo open` 과 같은 세션을 쓴다 */
export function tmuxSessionName(worktreePath: string): string {
  const canon = worktreePath.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
  return `minmo-${sha1Hex(canon).slice(0, 10)}`
}

/**
 * 원격 터미널 요청. tmux 가 있으면 첫 패널은 worktree 의 기본 세션(앱을 꺼도 유지),
 * 분할로 만든 패널은 떼면 사라지는 세션을 쓴다. tmux 가 없으면 로그인 셸.
 */
export function remotePty(alias: string, tmux: boolean, cwd: string, pane: { primary: boolean; seq: number }): RemotePty {
  if (!tmux) return { host: alias, session: null, ephemeral: false }
  const name = tmuxSessionName(cwd)
  return pane.primary ? { host: alias, session: name, ephemeral: false } : { host: alias, session: `${name}-p${pane.seq}`, ephemeral: true }
}
