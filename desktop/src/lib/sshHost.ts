// 원격 호스트(SSH 프로필)용 호스트 구현 — worktree 서비스(@minmo/core)가 쓰는 git·파일·스크립트 작업을
// `ssh <별칭> …` 으로 원격에서 실행한다. 원격은 POSIX(Linux·macOS)만 지원한다.
import type { CmdResult, RunOptions } from '@minmo/core'

import type { DirEntry, RemotePty, SshError, SshErrorKind, SshProbe, TauriApi } from './tauri'
import { REMOTE_SUBAGENTS_SCRIPT, claudeProjectSlug, parseRemoteSubagents } from '../features/agents/subagents'

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
  | 'listDir'
  | 'claudeSubagents'
  | 'readTextFile'
  | 'writeTextFile'
  | 'createDir'
  | 'renamePath'
  | 'removePath'
  | 'scriptRun'
  | 'scriptCancel'
  | 'ptyKillByCwd'
  | 'homeDir'
  | 'platform'
>

/** root($1) 아래 rel($2)의 경로 요소 중 심볼릭 링크가 있으면 실패 — 저장소에 커밋된 링크를 따라 밖에 쓰거나 읽지 않게 */
const NOLINK = `nolink() {
  np=$1; nold=$IFS; IFS=/; set -f
  for nc in $2; do np="$np/$nc"; if [ -L "$np" ]; then IFS=$nold; set +f; return 1; fi; done
  IFS=$nold; set +f; return 0
}
NL='
'`

/**
 * 덮어쓰지 않고, 심볼릭 링크는 따라가지 않는다(로컬 copy_tree 와 같은 규칙). 복사한 개수를 출력하고,
 * 복사에 실패한 파일이 있으면 실패로 끝난다. 이름에 줄바꿈이 있는 파일은 건너뛴다(줄 단위로 읽으므로).
 */
const COPY_TREE = `${NOLINK}
src=$1; dst=$2
[ -d "$src" ] || { echo 0; exit 0; }
cd -- "$src" || exit 1
find . -type f ! -name "*$NL*" -print | {
  n=0; bad=0
  while IFS= read -r f; do
    rel=\${f#./}; t="$dst/$rel"
    nolink "$dst" "$rel" || continue
    if [ -e "$t" ]; then continue; fi
    if mkdir -p -- "$(dirname -- "$t")" && cp -p -- "$f" "$t"; then n=$((n+1)); else bad=1; fi
  done
  echo "$n"
  exit $bad
}`

const LIST_FILES = `NL='
'
[ -d "$1" ] || exit 0
cd -- "$1" || exit 1
find . -type f ! -name "*$NL*" -print | sed 's|^\\./||' | LC_ALL=C sort`

const COPY_FILE = `${NOLINK}
s="$1/$2"; t="$3/$2"
if ! nolink "$1" "$2" || ! nolink "$3" "$2"; then echo "심볼릭 링크는 보관할 수 없습니다: $2" >&2; exit 1; fi
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
      return `처음 접속하는 호스트이거나 호스트 키가 바뀌었습니다(${alias}) — 처음이라면 [호스트 키 등록하고 연결] 을 누르세요. 그래도 실패하면 키가 바뀐 것이니 known_hosts 를 확인하세요.`
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

// ── 파일 탭(원격) — 로컬 fs.rs 의 fs_* 명령과 같은 규칙·같은 오류 코드 ──

const LINK_ERR = 'echo "심볼릭 링크를 지나는 경로는 쓸 수 없습니다" >&2; exit 1'

/** rel($2)이 비면 root. 한 줄에 하나씩 "<d|f|l>/<이름>" */
const LIST_DIR = `${NOLINK}
d=$1
if [ -n "$2" ]; then nolink "$1" "$2" || { ${LINK_ERR}; }; d="$1/$2"; fi
cd -- "$d" || exit 1
for f in .* *; do
  case "$f" in .|..|.git|*"$NL"*) continue ;; esac
  if [ -L "$f" ]; then printf 'l/%s\\n' "$f"; elif [ -d "$f" ]; then printf 'd/%s\\n' "$f"; elif [ -e "$f" ]; then printf 'f/%s\\n' "$f"; fi
done`

/** 첫 줄은 version(cksum), 그 뒤가 내용. 2MB(512바이트 블록 4096개) 초과는 열지 않는다 */
const READ_TEXT = `${NOLINK}
f="$1/$2"
nolink "$1" "$2" || { echo "file_link: 심볼릭 링크는 열 수 없습니다" >&2; exit 1; }
[ -f "$f" ] || { echo "파일이 아닙니다" >&2; exit 1; }
[ -z "$(find "$f" -prune -size +4096)" ] || { echo "file_too_large: 2MB 보다 큰 파일은 열 수 없습니다" >&2; exit 1; }
cksum < "$f" || exit 1
cat -- "$f"`

/**
 * 내용은 stdin 으로 받는다(그래서 스크립트는 sh -c 의 인자로 넘긴다). $3 = 읽을 때의 version, $4 = 1 이면 새 파일만,
 * $5 = 내용의 바이트 수. 같은 폴더의 임시 파일에 쓴 뒤 바꾸고, 기존 파일을 먼저 복사해 권한을 유지한다.
 * 전송 중 연결이 끊기면 받은 만큼만 쓰이므로, 바이트 수가 맞을 때만 원본을 바꾼다
 */
const WRITE_TEXT = `${NOLINK}
f="$1/$2"
nolink "$1" "$2" || { echo "file_link: 심볼릭 링크에는 쓸 수 없습니다" >&2; exit 1; }
if [ -e "$f" ]; then
  if [ "$4" = 1 ]; then echo "file_exists: 같은 이름이 이미 있습니다" >&2; exit 1; fi
  [ -f "$f" ] || { echo "파일이 아닙니다" >&2; exit 1; }
  if [ -n "$3" ] && [ "$(cksum < "$f")" != "$3" ]; then echo "file_changed: 연 뒤에 파일이 바뀌었습니다" >&2; exit 1; fi
fi
d=$(dirname -- "$f"); mkdir -p -- "$d" || exit 1
t="$d/.minmo-tmp-$$"
if [ -f "$f" ]; then cp -p -- "$f" "$t" || exit 1; fi
cat > "$t" || { rm -f -- "$t"; exit 1; }
if [ "$(wc -c < "$t" | tr -d ' ')" != "$5" ]; then rm -f -- "$t"; echo "전송이 중간에 끊겼습니다 — 파일을 바꾸지 않았습니다" >&2; exit 1; fi
mv -f -- "$t" "$f" || { rm -f -- "$t"; exit 1; }
cksum < "$f"`

const CREATE_DIR = `${NOLINK}
nolink "$1" "$2" || { ${LINK_ERR}; }
if [ -e "$1/$2" ]; then echo "file_exists: 같은 이름이 이미 있습니다" >&2; exit 1; fi
mkdir -p -- "$1/$2"`

/** 대상($3)이 이미 있으면 덮어쓰지 않는다. 링크 자체는 옮길 수 있게 원본은 상위 폴더까지만 검사한다 */
const RENAME_PATH = `${NOLINK}
s="$1/$2"; t="$1/$3"
nolink "$1" "$(dirname -- "$2")" && nolink "$1" "$3" || { ${LINK_ERR}; }
[ -e "$s" ] || [ -L "$s" ] || { echo "대상이 없습니다" >&2; exit 1; }
if [ -e "$t" ] || [ -L "$t" ]; then echo "file_exists: 같은 이름이 이미 있습니다" >&2; exit 1; fi
mkdir -p -- "$(dirname -- "$t")" && mv -- "$s" "$t"`

/** 파일·폴더(하위 포함) 삭제. 링크는 링크만 지운다 */
const REMOVE_PATH = `${NOLINK}
nolink "$1" "$(dirname -- "$2")" || { ${LINK_ERR}; }
rm -rf -- "$1/$2"`

/**
 * GitHub 토큰을 넘겨 git 을 실행한다. 토큰은 stdin 첫 줄로 받아 git 프로세스의 환경 변수로만 두고,
 * 이 명령에 한해 github.com 의 credential helper 로 답한다(원격의 helper 는 쓰지 않아 저장되지 않는다).
 * 원격 디스크·git 설정·명령줄(ps)에 토큰이 남지 않는다.
 */
const GIT_WITH_TOKEN =
  'IFS= read -r MINMO_GH_TOKEN || exit 1; export MINMO_GH_TOKEN; exec git -c credential.https://github.com.helper= -c \'credential.https://github.com.helper=!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$MINMO_GH_TOKEN"; }; f\' "$@" < /dev/null'

/**
 * 토큰을 넘길 git 하위 명령 — GitHub 와 통신하는 것, 그리고 부분 clone 에서 파일 내용을 그때 받아 오는 것.
 * status·diff·commit 같은 나머지에는 넘기지 않는다(저장소의 hook·필터가 토큰을 볼 기회를 줄인다)
 */
const TOKEN_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'worktree', 'read-tree', 'sparse-checkout', 'checkout'])

/** git 인자에서 하위 명령을 찾는다(-C <dir>·-c <k=v> 같은 전역 옵션은 건너뛴다) */
export function gitSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-C' || a === '-c') i++
    else if (!a.startsWith('-')) return a
  }
  return null
}

const byName = (a: DirEntry, b: DirEntry) => Number(a.kind !== 'dir') - Number(b.kind !== 'dir') || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name)

/** 파일 작업의 기준 폴더 — 로컬 guard_root(fs.rs)처럼 얕은 경로(홈·루트 등)에서는 하지 않는다 */
export function assertRoot(root: string): void {
  const parts = root.split('/').filter(Boolean)
  if (!root.startsWith('/') || parts.includes('..') || parts.includes('.') || parts.length < 3) throw new Error(`사용할 수 없는 폴더입니다: ${root}`)
}

/** 보관 파일의 상대 경로 — 폴더 밖을 가리키지 못하게 한다 */
export function assertRelative(rel: string): void {
  const parts = rel.split('/')
  if (rel === '' || rel.startsWith('/') || rel.includes('\\') || rel.includes('\n') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`상대 경로가 올바르지 않습니다: ${rel}`)
  }
}

/** getToken: 원격 git 에 넘길 GitHub 토큰(없으면 원격 자체의 자격 증명으로 실행한다) */
export function createSshOps(base: TauriApi, alias: string, probe: SshProbe, getToken?: () => Promise<string | null>): HostOps {
  const exec = (argv: string[], opts?: RunOptions & { stdin?: string }) => base.sshExec(alias, argv, opts)
  const script = (body: string, args: string[]) => exec(['sh', '-s', '--', ...args], { stdin: body })
  const inRoot = (root: string, ...rels: string[]) => {
    assertRoot(root)
    for (const rel of rels) assertRelative(rel)
  }
  const must = (r: CmdResult, what: string): CmdResult => {
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${what} 실패(종료 코드 ${r.code})`)
    return r
  }
  return {
    // 원격 git 이 자격 증명을 물으며 멈추지 않게(실패로 끝나게) 한다
    gitRun: async (args, opts) => {
      const env = { GIT_TERMINAL_PROMPT: '0', ...opts?.env }
      // 토큰에 줄바꿈이 있으면 한 줄 전달이 깨진다 — 그런 값은 쓰지 않는다
      const token = TOKEN_SUBCOMMANDS.has(gitSubcommand(args) ?? '') ? await getToken?.().catch(() => null) : null
      if (token && !/[\r\n]/.test(token)) return exec(['sh', '-c', GIT_WITH_TOKEN, 'sh', ...args], { cwd: opts?.cwd, env, stdin: `${token}\n` })
      return exec(['git', ...args], { cwd: opts?.cwd, env })
    },
    pathExists: async (path) => {
      const r = await exec(['test', '-e', path])
      // 1 만 "없음" 이다 — 그 밖의 실패(원격 셸 오류 등)를 없음으로 보면 새로고침이 worktree 기록을 지운다
      if (r.code > 1) throw new Error(r.stderr.trim() || `경로 확인 실패(종료 코드 ${r.code})`)
      return r.code === 0
    },
    removeDir: async (path) => {
      assertRemovable(path, probe.home)
      must(await exec(['rm', '-rf', '--', path]), '폴더 삭제')
    },
    copyTree: async (src, dst) => {
      assertRoot(src)
      assertRoot(dst)
      return Number(must(await script(COPY_TREE, [src, dst]), '파일 복사').stdout.trim()) || 0
    },
    listFiles: async (root) => {
      assertRoot(root)
      return must(await script(LIST_FILES, [root]), '파일 목록')
        .stdout.split('\n')
        .filter((l) => l !== '')
    },
    copyFileInto: async (srcRoot, rel, dstRoot) => {
      assertRoot(srcRoot)
      assertRoot(dstRoot)
      assertRelative(rel)
      must(await script(COPY_FILE, [srcRoot, rel, dstRoot]), '파일 보관')
    },
    removeFileIn: async (root, rel) => {
      assertRoot(root)
      assertRelative(rel)
      must(await exec(['rm', '-f', '--', `${root}/${rel}`]), '파일 삭제')
    },
    openDir: async () => {
      throw new Error('원격 폴더는 이 PC 의 탐색기로 열 수 없습니다')
    },
    // 원격의 Claude Code 세션 기록에서 하위 에이전트를 읽는다. 읽지 못하면 빈 목록(상태 표시는 그대로 동작)
    claudeSubagents: async (cwd) => {
      const r = await script(REMOTE_SUBAGENTS_SCRIPT, [claudeProjectSlug(cwd)])
      return r.code === 0 ? parseRemoteSubagents(r.stdout) : []
    },
    listDir: async (root, rel) => {
      assertRoot(root)
      if (rel !== '') assertRelative(rel)
      return must(await script(LIST_DIR, [root, rel]), '폴더 열기')
        .stdout.split('\n')
        .filter((l) => l.length > 2)
        .map((l): DirEntry => ({ name: l.slice(2), kind: l[0] === 'd' ? 'dir' : l[0] === 'l' ? 'link' : 'file' }))
        .sort(byName)
    },
    readTextFile: async (root, rel) => {
      inRoot(root, rel)
      const out = must(await script(READ_TEXT, [root, rel]), '파일 열기').stdout
      const cut = out.indexOf('\n')
      const content = out.slice(cut + 1)
      // ssh 출력은 UTF-8 로 읽는다 — 깨진 글자(U+FFFD)나 NUL 이 있으면 텍스트가 아니다
      if (content.includes('\0') || content.includes('\uFFFD')) throw new Error('file_binary: UTF-8 텍스트 파일이 아닙니다')
      return { content, version: out.slice(0, cut) }
    },
    writeTextFile: async (root, rel, content, opts) => {
      inRoot(root, rel)
      const bytes = String(new TextEncoder().encode(content).length)
      const r = await exec(['sh', '-c', WRITE_TEXT, 'sh', root, rel, opts?.expected ?? '', opts?.create ? '1' : '0', bytes], { stdin: content })
      return must(r, '파일 저장').stdout.trim()
    },
    createDir: async (root, rel) => {
      inRoot(root, rel)
      must(await script(CREATE_DIR, [root, rel]), '폴더 만들기')
    },
    renamePath: async (root, from, to) => {
      inRoot(root, from, to)
      must(await script(RENAME_PATH, [root, from, to]), '이름 바꾸기')
    },
    removePath: async (root, rel) => {
      inRoot(root, rel)
      must(await script(REMOVE_PATH, [root, rel]), '삭제')
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
