import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as Cause from 'effect/Cause'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Runtime from 'effect/Runtime'
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import packageJson from '../package.json' with { type: 'json' }
import { pie } from './Cli.ts'

const reportFailure = <Failure extends { readonly message: string }>(cause: Cause.Cause<Failure>) =>
  Result.match(Cause.findError(cause), {
    onSuccess: (error) =>
      Runtime.getErrorReported(error) ? Console.error(error.message) : Effect.void,
    onFailure: (remainingCause) =>
      Cause.hasDies(remainingCause) ? Effect.logError(remainingCause) : Effect.void,
  })

BunRuntime.runMain(
  Command.run(pie, { version: packageJson.version }).pipe(
    Effect.tapCause(reportFailure),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
  { disableErrorReporting: true },
)
