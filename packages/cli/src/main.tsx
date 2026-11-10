import { createContext, CliError } from './context'
import { buildProgram } from './program'
import { runTui } from './tui/run'

declare const __VERSION__: string | undefined

const version = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'

const program = buildProgram({ createCtx: () => createContext(), runTui, version })

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof CliError) {
    console.error(`minmo: ${e.message}`)
    process.exit(e.exitCode)
  }
  console.error(e)
  process.exit(1)
})
