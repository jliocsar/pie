import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import packageJson from '../package.json' with { type: 'json' }
import { pie } from './Cli.ts'

BunRuntime.runMain(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide
  Command.run(pie, { version: packageJson.version }).pipe(Effect.provide(BunServices.layer)),
)
