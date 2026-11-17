// 원격 호스트의 AI 별 사용량 — 이 PC 의 Rust 구현(src-tauri/src/commands/usage.rs)과 같은 계산을 원격의 python3 으로 한다.
// 원격에는 minmo 를 설치하지 않으므로(ssh 로 스크립트만 보낸다) 계산이 두 벌이다 — 규칙을 바꾸면 함께 바꾸고,
// 두 구현은 같은 fixture(src-tauri/tests/fixtures/usage)로 맞춘다(remoteUsage.test.ts).
import type { AgentUsage, CodexUsage, UsageLimit, UsageTokens } from '../../lib/tauri'

/**
 * $1 = since(ms, 화면의 오늘 자정), $2 = 지금(ms, 테스트용 — 없으면 원격의 시계).
 * 결과는 JSON 한 줄. python3 이 없으면 {"unavailable":"python3"} — JSON 을 sh·awk 로 읽지는 않는다(깨지기 쉽다).
 * 본문에 역슬래시와 달러-중괄호를 쓰지 않는다(이 파일의 템플릿 문자열과 sh 의 heredoc 을 그대로 지나가야 한다).
 */
export const REMOTE_USAGE_SCRIPT = `command -v python3 >/dev/null 2>&1 || { echo '{"unavailable":"python3"}'; exit 0; }
exec python3 - "$1" "$2" <<'MINMO_USAGE_PY'
import json, math, os, sys, time
from datetime import datetime, timezone

SINCE = int(sys.argv[1])
NOW = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else int(time.time() * 1000)
LIMIT_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000


def iso_ms(s):
    try:
        if not isinstance(s, str) or len(s) < 19:
            return None
        base = datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
        digits = ''
        if s[19:20] == '.':
            for c in s[20:]:
                if not c.isdigit() or len(digits) == 3:
                    break
                digits += c
        ms = int(base.timestamp()) * 1000 + int((digits + '000')[:3])
        return ms if ms >= 0 else None
    except Exception:
        return None


def num(v, key):
    x = v.get(key) if isinstance(v, dict) else None
    return x if isinstance(x, int) and not isinstance(x, bool) and x >= 0 else 0


def ts_ms(v):
    return iso_ms(v.get('timestamp')) if isinstance(v, dict) else None


def children(d):
    try:
        return [e.path for e in os.scandir(d)]
    except OSError:
        return []


def has_ext(p, ext):
    return os.path.isfile(p) and p.endswith('.' + ext)


def mtime_ms(p):
    try:
        return os.stat(p).st_mtime_ns // 1000000
    except OSError:
        return None


def json_lines(path, key):
    # 대부분의 줄은 사용량과 무관하다 - key 가 든 줄만 JSON 으로 읽는다. 쓰는 도중의 줄·깨진 글자는 건너뛴다
    needle = key.encode('utf-8')
    try:
        f = open(path, 'rb')
    except OSError:
        return
    with f:
        for raw in f:
            if needle not in raw:
                continue
            try:
                yield json.loads(raw.decode('utf-8'))
            except Exception:
                continue


def tokens(i=0, o=0, cw=0, cr=0):
    return {'input': i, 'output': o, 'cacheWrite': cw, 'cacheRead': cr}


def add(a, b):
    for k in a:
        a[k] += b[k]


def claude_usage(projects):
    if not os.path.isdir(projects):
        return None
    files = []
    for project in children(projects):
        for entry in children(project):
            if has_ext(entry, 'jsonl'):
                files.append(entry)
            elif os.path.isdir(entry):
                files.extend(p for p in children(os.path.join(entry, 'subagents')) if has_ext(p, 'jsonl'))
    seen = set()
    total = tokens()
    for path in files:
        m = mtime_ms(path)
        if m is None or m < SINCE:
            continue
        n = 0
        for v in json_lines(path, '"usage"'):
            n += 1
            msg = v.get('message') if isinstance(v, dict) else None
            if not isinstance(msg, dict) or 'usage' not in msg:
                continue
            at = ts_ms(v)
            if at is None or at < SINCE:
                continue
            usage = msg['usage']
            mid = msg.get('id') if isinstance(msg.get('id'), str) else None
            req = v.get('requestId') if isinstance(v.get('requestId'), str) else None
            # 같은 응답은 한 번만 센다(여러 줄·이어 연 세션의 여러 파일에 기록된다)
            if mid is not None and req is not None:
                key = mid + ':' + req
            elif mid is not None:
                key = mid
            else:
                key = path + '#' + str(n)
            if key in seen:
                continue
            seen.add(key)
            add(total, tokens(num(usage, 'input_tokens'), num(usage, 'output_tokens'), num(usage, 'cache_creation_input_tokens'), num(usage, 'cache_read_input_tokens')))
    return total


def codex_limits(rate, at):
    out = []
    for k in ('primary', 'secondary'):
        l = rate.get(k)
        if not isinstance(l, dict):
            continue
        used = l.get('used_percent')
        if isinstance(used, bool) or not isinstance(used, (int, float)):
            continue
        # NaN·무한대·너무 큰 수는 JSON 으로 내보낼 수 없다(화면이 결과 전체를 읽지 못한다) - 그 한도만 뺀다
        try:
            used = float(used)
        except OverflowError:
            continue
        if not math.isfinite(used):
            continue
        resets_at = l.get('resets_at')
        resets_in = l.get('resets_in_seconds')
        is_count = lambda x: isinstance(x, int) and not isinstance(x, bool) and x >= 0
        # 버전에 따라 초기화 시각(초) 또는 남은 시간(초)으로 적는다
        resets = resets_at * 1000 if is_count(resets_at) else (at + resets_in * 1000 if is_count(resets_in) else 0)
        out.append({'usedPercent': used, 'windowMinutes': num(l, 'window_minutes'), 'resetsAtMs': resets})
    return out


def codex_file(path):
    tok = tokens()
    limits = None
    prev = None
    for v in json_lines(path, '"token_count"'):
        p = v.get('payload') if isinstance(v, dict) else None
        if not isinstance(p, dict) or p.get('type') != 'token_count':
            continue
        at = ts_ms(v)
        if at is None:
            continue
        info = p.get('info')
        total = info.get('total_token_usage') if isinstance(info, dict) else None
        if isinstance(total, dict):
            now = (num(total, 'input_tokens'), num(total, 'cached_input_tokens'), num(total, 'output_tokens'))
            last = info.get('last_token_usage')
            if prev is None and isinstance(last, dict):
                # 파일의 첫 기록: 이어 연 세션은 누적값에 이전 파일의 사용량이 들어 있다 - 이번 턴의 값이 있으면 그것만 센다
                i, c, o = num(last, 'input_tokens'), num(last, 'cached_input_tokens'), num(last, 'output_tokens')
            elif prev is not None and all(now[k] >= prev[k] for k in range(3)):
                # 같은 턴의 사용량이 여러 번 기록된다 - 누적값의 증가분만 센다
                i, c, o = now[0] - prev[0], now[1] - prev[1], now[2] - prev[2]
            else:
                # 누적값이 줄었으면(기록이 새로 시작됨) 그 값 전체가 증가분이다
                i, c, o = now
            prev = now
            if at >= SINCE:
                # Codex 의 input_tokens 는 캐시에서 읽은 것을 포함한다
                add(tok, tokens(max(i - c, 0), o, 0, c))
        rate = p.get('rate_limits')
        if isinstance(rate, dict):
            found = codex_limits(rate, at)
            if found:
                limits = (at, found)
    return tok, limits


def codex_usage(sessions):
    if not os.path.isdir(sessions):
        return None
    files = []
    for year in children(sessions):
        for month in children(year):
            for day in children(month):
                for f in children(day):
                    m = mtime_ms(f) if has_ext(f, 'jsonl') else None
                    if m is not None:
                        files.append((f, m))
    # 한도는 가장 최근 기록의 것 - 오늘 쓰지 않았어도 지난 기록에서 찾는다
    oldest = min(SINCE, max(NOW - LIMIT_LOOKBACK_MS, 0))
    files = sorted((f for f in files if f[1] >= oldest), key=lambda f: -f[1])
    total = tokens()
    latest = None
    for path, m in files:
        # 오늘 바뀌지 않은 파일은 더 최근의 한도 기록이 있을 수 있을 때만 읽는다 - 파일의 기록은 그 파일의 수정 시각보다 뒤일 수 없다
        if m < SINCE and latest is not None and latest[0] >= m:
            continue
        tok, limits = codex_file(path)
        add(total, tok)
        if limits is not None and (latest is None or limits[0] > latest[0]):
            latest = limits
    return {'tokens': total, 'limits': latest[1] if latest else [], 'limitsAtMs': latest[0] if latest else 0}


def gemini_usage(tmp):
    if not os.path.isdir(tmp):
        return None
    total = tokens()
    for project in children(tmp):
        for path in children(os.path.join(project, 'chats')):
            m = mtime_ms(path) if has_ext(path, 'json') else None
            if m is None or m < SINCE:
                continue
            try:
                with open(path, 'rb') as f:
                    v = json.loads(f.read().decode('utf-8'))
            except Exception:
                continue
            msgs = v.get('messages') if isinstance(v, dict) else None
            for msg in msgs if isinstance(msgs, list) else []:
                t = msg.get('tokens') if isinstance(msg, dict) else None
                at = ts_ms(msg)
                if not isinstance(t, dict) or at is None or at < SINCE:
                    continue
                cached = num(t, 'cached')
                # Gemini 의 input 은 캐시에서 읽은 것을 포함한다
                add(total, tokens(max(num(t, 'input') - cached, 0), num(t, 'output') + num(t, 'thoughts') + num(t, 'tool'), 0, cached))
    return total


home = os.path.expanduser('~')
claude_dir = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(home, '.claude')
codex_dir = os.environ.get('CODEX_HOME') or os.path.join(home, '.codex')
print(json.dumps({
    'claude': claude_usage(os.path.join(claude_dir, 'projects')),
    'codex': codex_usage(os.path.join(codex_dir, 'sessions')),
    'gemini': gemini_usage(os.path.join(home, '.gemini', 'tmp')),
}, allow_nan=False))
MINMO_USAGE_PY`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

function parseTokens(v: unknown): UsageTokens | null {
  if (!isRecord(v)) return null
  return { input: count(v.input), output: count(v.output), cacheWrite: count(v.cacheWrite), cacheRead: count(v.cacheRead) }
}

function parseCodex(v: unknown): CodexUsage | null {
  const tokens = isRecord(v) ? parseTokens(v.tokens) : null
  if (!isRecord(v) || !tokens) return null
  const limits = (Array.isArray(v.limits) ? v.limits : [])
    .filter(isRecord)
    .filter((l) => typeof l.usedPercent === 'number' && Number.isFinite(l.usedPercent))
    .map((l): UsageLimit => ({ usedPercent: l.usedPercent as number, windowMinutes: count(l.windowMinutes), resetsAtMs: count(l.resetsAtMs) }))
  return { tokens, limits, limitsAtMs: count(v.limitsAtMs) }
}

export const EMPTY_USAGE: AgentUsage = { claude: null, codex: null, gemini: null }

/**
 * 원격 스크립트의 출력(JSON 한 줄) → 사용량. 모양이 맞지 않는 부분은 "없음"으로 본다 —
 * 원격의 출력은 믿을 수 없는 입력이고(로그인 셸의 인사말이 섞일 수 있다), 화면은 숫자만 그린다.
 */
export function parseRemoteUsage(stdout: string): AgentUsage {
  // 로그인 셸이 앞에 다른 글을 찍었을 수 있다 — JSON 인 마지막 줄을 읽는다
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  let v: unknown
  try {
    v = JSON.parse(line ?? '')
  } catch {
    return EMPTY_USAGE
  }
  if (!isRecord(v)) return EMPTY_USAGE
  const out: AgentUsage = { claude: parseTokens(v.claude), codex: parseCodex(v.codex), gemini: parseTokens(v.gemini) }
  if (v.unavailable === 'python3') out.unavailable = 'python3'
  return out
}
