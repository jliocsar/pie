import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import { identity } from 'effect/Function'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type { PlatformError } from 'effect/PlatformError'
import * as Redacted from 'effect/Redacted'
import * as Str from 'effect/String'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import {
  AdminOnly,
  Authentication,
  CONFIG_STALE_HEADER,
  ConfigPull,
  CurrentDevice,
  NotAnAdmin,
  TokenMissing,
  TokenUnknown,
} from '../Api.ts'
import {
  ConfigRepository,
  type GitCommandFailed,
  type GitCommandTimedOut,
} from './ConfigRepository.ts'
import { Devices } from './Devices.ts'
import { hashSecret } from './Secrets.ts'

export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const devices = yield* Devices

    const authenticate = Effect.fn('authenticate')(function* (credential: Redacted.Redacted) {
      const token = yield* Option.liftPredicate(Redacted.value(credential), Str.isNonEmpty).pipe(
        Option.match({ onNone: () => Effect.fail(new TokenMissing()), onSome: Effect.succeed }),
      )
      const tokenHash = yield* hashSecret(token).pipe(Effect.provideService(Crypto.Crypto, crypto))
      const device = yield* devices
        .findByTokenHash(tokenHash)
        .pipe(
          Effect.flatMap(
            Option.match({ onNone: () => Effect.fail(new TokenUnknown()), onSome: Effect.succeed }),
          ),
        )

      yield* devices.touchLastSeen(device.name)

      return device
    })

    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        authenticate(credential).pipe(
          Effect.catchTags({
            PlatformError: Effect.die,
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
          Effect.flatMap((device) => Effect.provideService(httpEffect, CurrentDevice, device)),
        ),
    })
  }),
)

export const adminOnlyLayer = Layer.succeed(AdminOnly, (httpEffect) =>
  Effect.service(CurrentDevice).pipe(
    Effect.filterOrFail(
      (device) => device.kind === 'admin',
      (device) => new NotAnAdmin({ deviceName: device.name }),
    ),
    Effect.andThen(httpEffect),
  ),
)

export const configPullLayer = Layer.effect(
  ConfigPull,
  Effect.gen(function* () {
    const configRepository = yield* ConfigRepository
    const serveLastPull = (pullError: GitCommandFailed | GitCommandTimedOut | PlatformError) =>
      Effect.logWarning(`Serving the last config pull. ${pullError.message}`).pipe(
        Effect.as(HttpServerResponse.setHeader(CONFIG_STALE_HEADER, 'true')),
      )

    return ConfigPull.of((httpEffect) =>
      configRepository.pull.pipe(
        Effect.as(identity<HttpServerResponse.HttpServerResponse>),
        Effect.catchTags({
          GitCommandFailed: serveLastPull,
          GitCommandTimedOut: serveLastPull,
          PlatformError: serveLastPull,
        }),
        Effect.flatMap((markResponse) => Effect.map(httpEffect, markResponse)),
      ),
    )
  }),
)
