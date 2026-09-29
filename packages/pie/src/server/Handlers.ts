import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import { CurrentDevice, PieApi } from '../Api.ts'
import { ConfigRepository } from './ConfigRepository.ts'
import { Devices } from './Devices.ts'
import { Invites } from './Invites.ts'
import { PodConfigs } from './PodConfigs.ts'

const devicesHandlers = HttpApiBuilder.group(PieApi, 'devices', (handlers) =>
  handlers.handle('whoami', () => Effect.service(CurrentDevice)),
)

const podsHandlers = HttpApiBuilder.group(
  PieApi,
  'pods',
  Effect.fn(function* (handlers) {
    const devices = yield* Devices

    return handlers.handle('list', () => devices.listPods.pipe(Effect.orDie))
  }),
)

const joinHandlers = HttpApiBuilder.group(
  PieApi,
  'join',
  Effect.fn(function* (handlers) {
    const invites = yield* Invites

    return handlers.handle('join', ({ payload }) =>
      invites.redeem(payload.secret).pipe(
        Effect.catchTags({
          NoSuchElementError: Effect.die,
          PlatformError: Effect.die,
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      ),
    )
  }),
)

const invitesHandlers = (serverUrl: string) =>
  HttpApiBuilder.group(
    PieApi,
    'invites',
    Effect.fn(function* (handlers) {
      const invites = yield* Invites
      const configRepository = yield* ConfigRepository

      return handlers.handle('create', ({ payload }) =>
        Effect.gen(function* () {
          const creator = yield* CurrentDevice

          yield* Option.match(payload.recipeName, {
            onNone: () => Effect.void,
            onSome: configRepository.failWhenRecipeMissing,
          })

          return yield* invites.create({ ...payload, createdBy: creator.name, serverUrl })
        }).pipe(
          Effect.catchTags({
            NoSuchElementError: Effect.die,
            PlatformError: Effect.die,
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
        ),
      )
    }),
  )

const podHandlers = HttpApiBuilder.group(
  PieApi,
  'pod',
  Effect.fn(function* (handlers) {
    const devices = yield* Devices
    const podConfigs = yield* PodConfigs

    return handlers
      .handle('config', () =>
        Effect.flatMap(Effect.service(CurrentDevice), podConfigs.forDevice).pipe(
          Effect.catchTags({
            GitCommandFailed: Effect.die,
            GitCommandTimedOut: Effect.die,
            PlatformError: Effect.die,
          }),
        ),
      )
      .handle('up', ({ payload }) =>
        Effect.flatMap(Effect.service(CurrentDevice), (device) =>
          devices.recordUpCommit(device.name, payload.commit),
        ).pipe(Effect.catchTags({ SqlError: Effect.die })),
      )
  }),
)

export const handlersLayer = (serverUrl: string) =>
  Layer.mergeAll(
    joinHandlers,
    devicesHandlers,
    podsHandlers,
    invitesHandlers(serverUrl),
    podHandlers,
  )
