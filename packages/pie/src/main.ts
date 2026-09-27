import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import packageJson from '../package.json' with { type: 'json' }
import { pie } from './Cli.ts'

BunRuntime.runMain(
  Command.run(pie, { version: packageJson.version }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
)
