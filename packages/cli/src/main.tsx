import { createContext, CliError } from './context'
import { buildProgram } from './program'
import { defaultPaths } from './store'
import { runTui } from './tui/run'
import { notifyUpdate } from './update'

declare const __VERSION__: string | undefined

const version = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'

const program = buildProgram({ createCtx: () => createContext(), runTui, version })

program
  .parseAsync(process.argv)
  .then(async () => {
    // 명령이 끝난 뒤 새 버전 알림(하루 한 번 확인, stderr) — update 명령 자신은 제외
    if (process.argv[2] === 'update') return
    await notifyUpdate({
      version,
      configDir: defaultPaths().configDir,
      env: process.env,
      isTTY: process.stderr.isTTY === true,
      write: (line) => process.stderr.write(`${line}\n`),
      fetch: (input, init) => globalThis.fetch(input, init),
    })
  })
  .catch((e: unknown) => {
    if (e instanceof CliError) console.error(`minmo: ${e.message}`)
    else console.error(e)
    // process.exit 대신 종료 코드만 정한다 — Windows 의 Node 24 는 HTTPS fetch 뒤 곧바로 process.exit 하면 libuv
    // assertion 으로 죽는다. 남은 핸들이 프로세스를 붙잡으면 잠시 뒤 강제로 끝낸다(unref: 정상이면 기다리지 않음)
    const code = e instanceof CliError ? e.exitCode : 1
    process.exitCode = code
    setTimeout(() => process.exit(code), 3_000).unref()
  })
