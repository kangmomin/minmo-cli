#!/usr/bin/env python3
"""check_new_comments.py — 새로 추가한 주석만 검사한다 (Go·TS·JS). 기존 주석은 diff 밖이라 보지 않는다.

규칙: 주석은 코드·테스트·lint 로 옮길 수 없는 "이유"만 남긴다. 그중 기계로 판정할 수 있는 두 가지를 고정한다.
  1) 새 주석 블록은 연속 N줄 이하다 (기본 2 — COMMENT_MAX_BLOCK_LINES 또는 --max-block).
     `/*`·`/**`·`*/` 만 있는 줄은 세지 않고 블록도 끊지 않는다 (빈 `//` 줄은 센다). 지시문(//go:·//nolint·// eslint-… 등)은 블록을 끊는다.
  2) 주석에 Spec 추적 ID(AC-nn·EC-nn·RC-nn)를 쓰지 않는다 — 테스트 이름에 둔다.
  3) 새 주석 단위(`/* */` 하나, 연속된 `//` 줄 묶음, 줄 끝 주석)의 첫 본문은 `Why:` 또는 `[Assumption]` 으로 시작한다.
     "코드로 알 수 없는 이유인가"를 접두사로 고정해 LLM 판정을 없앤다. 단위당 1건, 그 단위의 첫 새 줄에 보고한다.
     예외: Go exported 선언 바로 위에서 그 이름으로 시작하는 문서 주석(`// Load ...`).
입력: --base REF  = git merge-base(REF, HEAD) → 작업 트리 diff (레포 설치·CI·pre-commit 용)
      --scope F|- = workflow_scope.py JSON (convention-check 용, 범위를 다시 계산하지 않는다)
제외: 테스트(*_test.go·*.test.*·*.spec.*·__tests__/·e2e/ 등), 생성 파일(*.pb.go·*.gen.*·머리말 `Code generated`/`@generated`),
      vendor·node_modules·dist·build.
출력: 기본은 `path:line: 메시지` 줄. --json 이면 convention_facts.py 와 같은 findings JSON(tag COMMENT_STYLE).
종료: 0 = 위반 없음 / 1 = 위반 있음 / 2 = 입력·git 오류 (BLOCKED:COMMENT_CHECK).
의존: 표준 라이브러리만. 사용: python3 check_new_comments.py --base origin/main
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

SOURCE_SUFFIXES = {'.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'}
SKIP_DIRS = {'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', 'testdata',
             '__tests__', '__mocks__', 'e2e', 'cypress', 'playwright', 'generated', '__generated__'}
SKIP_MARKS = ('.test.', '.spec.', '.gen.', '.generated.')
SKIP_SUFFIXES = ('_test.go', '.pb.go', '.pb.gw.go', '_gen.go', '_string.go', '.d.ts')
GENERATED_HEADER = re.compile(r'Code generated .* DO NOT EDIT|@generated|auto-generated', re.I)
DIRECTIVE = re.compile(r'^(?:go:|nolint|export |line |extern |/\s*<reference)'
                       r'|^\s*(?:eslint|@ts-|prettier-ignore|biome-ignore|istanbul |c8 |v8 |@vite-ignore'
                       r'|webpack|[#@]__PURE__|@jsx|@refresh|global |jshint|tslint'
                       r'|nolint|\+build|lint:ignore|lint:file-ignore|#nosec|#?(?:end)?region\b'
                       r'|@type\b|@vitest-environment|@jest-environment|@flow\b|@license|@preserve)')
SPEC_ID = re.compile(r'(?<![A-Za-z])(?:AC|EC|RC)-\d')
REASON_PREFIX = re.compile(r'^(?:Why:|\[Assumption\])')
GO_EXPORTED_DECL = re.compile(r'^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Z]\w*)')
MSG_BLOCK = '주석 블록은 {max}줄 이하다 — 이유만 남기고 나머지는 코드·테스트로 옮긴다'
MSG_SPEC_ID = '주석에 Spec 추적 ID 를 쓰지 않는다 — 테스트 이름에 둔다'
MSG_REASON = '새 주석은 Why: 또는 [Assumption] 으로 시작한다 — 코드로 알 수 없는 이유만 남긴다'


class CheckError(ValueError):
    pass


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, timeout=60)
    if result.returncode:
        raise CheckError('git ' + args[0] + ' failed: ' + result.stderr.decode('utf-8', errors='replace').strip())
    return result.stdout


def target(path, text):
    pure = PurePosixPath(path)
    if pure.suffix not in SOURCE_SUFFIXES or pure.name.endswith(SKIP_SUFFIXES):
        return False
    if any(mark in pure.name for mark in SKIP_MARKS) or any(part in SKIP_DIRS for part in pure.parts[:-1]):
        return False
    return not GENERATED_HEADER.search('\n'.join(text.split('\n', 10)[:10]))


def strip_body(piece):
    return piece.strip().lstrip('*').strip()


def is_directive(piece):
    return bool(DIRECTIVE.search(piece) or DIRECTIVE.search(strip_body(piece)))


def classify(text, go):
    """줄마다 (종류, 주석 본문) — 종류: comment·delim·directive·code·blank. 문자열 안의 // 는 주석이 아니다.
    주석 단위 목록도 돌려준다: `/* */` 하나, 또는 코드 없는 줄에 연속된 `//` 묶음 하나. texts = [(줄 번호, 조각)]."""
    out, state, units = [], None, []
    for number, line in enumerate(text.split('\n'), 1):
        segments, code, slashes, j, n = [], False, False, 0, len(line)
        while j < n:
            if state == 'block':
                end = line.find('*/', j)
                segments.append(line[j:] if end < 0 else line[j:end])
                units[-1]['texts'].append((number, segments[-1]))
                if end < 0:
                    break
                state, j = None, end + 2
                continue
            ch = line[j]
            if state:
                if ch == '\\' and not (go and state == '`'):
                    j += 2
                    continue
                if ch == state:
                    state = None
                j += 1
                continue
            if line.startswith('//', j):
                piece = line[j + 2:]
                segments.append(piece)
                slashes = True
                prev = units[-1] if units else None
                if (not code and prev and prev['group'] and prev['texts'][-1][0] == number - 1
                        and not is_directive(piece) and not is_directive(prev['texts'][0][1])):
                    prev['texts'].append((number, piece))
                else:
                    units.append(dict(group=not code, texts=[(number, piece)]))
                break
            if line.startswith('/*', j):
                units.append(dict(group=False, texts=[]))
                state, j = 'block', j + 2
                continue
            if ch in '"\'`':
                state = ch
            if not ch.isspace():
                code = True
            j += 1
        if state in ('"', "'"):
            state = None  # 닫히지 않은 따옴표(JSX 텍스트의 ' 등)는 줄 끝에서 끝낸다
        body = ' '.join(s.strip().lstrip('*').strip() for s in segments).strip()
        if code:
            kind = 'code'
        elif not segments:
            kind = 'blank'
        elif segments[0] and DIRECTIVE.search(segments[0]):
            kind = 'directive'
        else:
            kind = 'comment' if body or slashes else 'delim'
        out.append((kind, body if kind != 'directive' else ''))
    return out, units


def go_doc_comment(unit, body, lines):
    """Why: revive·staticcheck 가 exported 심볼 문서 주석을 `// Name ...` 형식으로 요구해 Why: 접두사와 충돌한다."""
    following = unit['texts'][-1][0]
    decl = GO_EXPORTED_DECL.match(lines[following]) if following < len(lines) else None
    return bool(decl) and re.match(re.escape(decl[1]) + r'(?![A-Za-z0-9_])', body) is not None


def reason_violations(path, units, numbers, lines):
    """규칙 3: 새 본문 줄이 있는 주석 단위는 첫 본문이 Why:·[Assumption] 이어야 한다. 단위당 1건."""
    found = []
    for unit in units:
        bodies = [(n, strip_body(piece)) for n, piece in unit['texts'] if strip_body(piece)]
        added = [n for n, _ in bodies if n in numbers]
        if not added or is_directive(unit['texts'][0][1]) or is_directive(bodies[0][1]):
            continue
        if REASON_PREFIX.match(bodies[0][1]) or (path.endswith('.go') and go_doc_comment(unit, bodies[0][1], lines)):
            continue
        found.append((path, min(added), MSG_REASON))
    return found


def violations(path, text, numbers, max_block):
    kinds, units = classify(text, path.endswith('.go'))
    found, run, last = [], 0, None
    for number in sorted(numbers):
        if number < 1 or number > len(kinds):
            continue
        kind, body = kinds[number - 1]
        if kind == 'comment':
            run = run + 1 if last == number - 1 else 1
            last = number
            if run == max_block + 1:
                found.append((path, number, MSG_BLOCK.format(max=max_block)))
        elif kind == 'delim':
            run, last = (run if last == number - 1 else 0), number
        else:
            run, last = 0, None
        if body and SPEC_ID.search(body):
            found.append((path, number, MSG_SPEC_ID))
    return found + reason_violations(path, units, numbers, text.split('\n'))


def unquote(name):
    if not name.startswith('"'):
        return name
    raw = name[1:-1].encode('latin-1', errors='backslashreplace').decode('unicode_escape')
    return raw.encode('latin-1', errors='replace').decode('utf-8', errors='replace')


def added_lines(patch):
    """통합 diff → {path: {현재 쪽 줄 번호}}."""
    found, path, number, in_hunk = {}, None, 0, False
    for line in patch.split('\n'):
        if line.startswith('diff --git '):
            path, in_hunk = None, False
        elif not in_hunk and line.startswith('+++ '):
            name = unquote(line[4:].rstrip('\r'))
            path = None if name == '/dev/null' else name[2:] if name.startswith('b/') else name
        elif line.startswith('@@'):
            hunk = re.match(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@', line)
            if hunk:
                number, in_hunk = int(hunk[1]), True
        elif in_hunk and line.startswith('+'):
            if path:
                found.setdefault(path, set()).add(number)
            number += 1
        elif in_hunk and line.startswith(' '):
            number += 1
    return found


def worktree_text(root, path):
    file = Path(root) / path
    if not file.is_file() or file.is_symlink():
        return None
    return file.read_bytes().decode('utf-8', errors='replace')


def check(sources, max_block):
    """sources: [(path, text, added line numbers)] → 정렬된 위반 목록."""
    found = set()
    for path, text, numbers in sources:
        if text is not None and numbers and target(path, text):
            found.update(violations(path, text, numbers, max_block))
    return sorted(found)


def from_base(root, base, max_block):
    merge_base = git(root, 'merge-base', base, 'HEAD').decode().strip()
    patch = git(root, 'diff', '-U0', '--no-color', '--no-ext-diff', merge_base, '--').decode('utf-8', errors='surrogateescape')
    return check([(p, worktree_text(root, p), n) for p, n in added_lines(patch).items()], max_block)


def read_patch(data, key):
    if isinstance(data.get(key), str):
        return data[key]
    if key + '_file' not in data:
        return ''
    payload = Path(data[key + '_file']).read_bytes()
    expected = data.get(key + '_sha256')
    if expected and hashlib.sha256(payload).hexdigest() != expected:
        raise CheckError(key + '_file sha256 mismatch')
    return payload.decode('utf-8', errors='surrogateescape')


def from_scope(source, max_block):
    raw = sys.stdin.buffer.read() if source == '-' else Path(source).read_bytes()
    data = json.loads(raw.decode('utf-8'))
    if not isinstance(data, dict) or data.get('schema_version') != 1 or not isinstance(data.get('root'), str):
        raise CheckError('scope JSON schema_version 1 and root required')
    root = data['root']
    sources = [(p, worktree_text(root, p), n) for p, n in added_lines(read_patch(data, 'patch')).items()]
    for path, numbers in added_lines(read_patch(data, 'index_patch')).items():
        index = subprocess.run(['git', '-C', root, 'show', ':' + path], capture_output=True, timeout=60)
        if index.returncode == 0:
            sources.append((path, index.stdout.decode('utf-8', errors='replace'), numbers))
    for path in data.get('owned_untracked', []):
        text = worktree_text(root, path)
        if text is not None:
            sources.append((path, text, set(range(1, text.count('\n') + 2))))
    return root, check(sources, max_block)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--base', help='비교 기준 ref (merge-base 를 구한다)')
    mode.add_argument('--scope', help='workflow_scope.py JSON 경로, - 이면 stdin')
    parser.add_argument('--root', default='.', help='--base 모드의 저장소 경로 (기본 현재 디렉터리)')
    parser.add_argument('--max-block', type=int, help='주석 블록 최대 줄 수 (기본 COMMENT_MAX_BLOCK_LINES 또는 2)')
    parser.add_argument('--json', action='store_true', help='findings JSON 으로 출력')
    args = parser.parse_args()
    try:
        max_block = args.max_block if args.max_block is not None else int(os.environ.get('COMMENT_MAX_BLOCK_LINES') or 2)
        if max_block < 1:
            raise CheckError('max-block must be >= 1')
        if args.scope:
            root, found = from_scope(args.scope, max_block)
        else:
            root, found = args.root, from_base(args.root, args.base, max_block)
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        sys.stderr.buffer.write(('BLOCKED:COMMENT_CHECK — ' + str(exc) + '\n').encode('utf-8'))
        return 2
    if args.json:
        findings = [dict(tag='COMMENT_STYLE', severity='ERROR', path=p, line=n, detail=m) for p, n, m in found]
        text = json.dumps(dict(schema_version=1, root=root, max_block=max_block, findings=findings), ensure_ascii=False, indent=2) + '\n'
    else:
        text = ''.join('%s:%d: %s\n' % item for item in found)
    sys.stdout.buffer.write(text.encode('utf-8'))
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
