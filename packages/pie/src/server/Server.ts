import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Headers from 'effect/unstable/http/Headers'
import * as HttpMiddleware from 'effect/unstable/http/HttpMiddleware'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import type * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import { CLIENT_VERSION_HEADER, PieApi } from '../Api.ts'
import { ConfigRepository } from './ConfigRepository.ts'
import { databaseLayer } from './Database.ts'
import { Devices } from './Devices.ts'
import { handlersLayer } from './Handlers.ts'
import { Invites } from './Invites.ts'
import { adminOnlyLayer, authenticationLayer, configPullLayer } from './Middleware.ts'
import { PodConfigs } from './PodConfigs.ts'
import { Settings } from './Settings.ts'

const announceServerUrl = Effect.fn('announceServerUrl')(function* (
  serverUrl: string,
  dataDirectory: string,
) {
  const settings = yield* Settings
  const devices = yield* Devices

  yield* settings.recordServerUrl(serverUrl)
  yield* Effect.logInfo(
    `No admin device yet. Run \`pie bootstrap --data-dir ${dataDirectory}\` on this box to get the master invite.`,
  ).pipe(Effect.when(Effect.map(devices.countAdmins, (adminCount) => adminCount === 0)))
})

export const apiLayer = (settings: {
  readonly dataDirectory: string
  readonly configRepositoryUrl: string
  readonly serverUrl: string
}) => {
  const { dataDirectory, configRepositoryUrl, serverUrl } = settings
  const servicesLayer = Layer.mergeAll(
    Devices.layer,
    Settings.layer,
    Invites.layer,
    PodConfigs.layer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        databaseLayer(dataDirectory),
        ConfigRepository.layer(dataDirectory, configRepositoryUrl),
      ),
    ),
  )
  const servicesAndMiddleware = Layer.mergeAll(
    authenticationLayer,
    adminOnlyLayer,
    configPullLayer,
    Layer.effectDiscard(announceServerUrl(serverUrl, dataDirectory)),
  ).pipe(Layer.provideMerge(servicesLayer))

  return HttpApiBuilder.layer(PieApi).pipe(
    Layer.provide(handlersLayer(serverUrl).pipe(Layer.provide(servicesAndMiddleware))),
  )
}

const logRequestWithClientVersion = <Failure, Requirements>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const clientVersion = Headers.get(request.headers, CLIENT_VERSION_HEADER).pipe(
      Option.getOrElse(() => 'unknown'),
    )

    return yield* HttpMiddleware.logger(httpApp).pipe(
      Effect.annotateLogs('client.version', clientVersion),
    )
  })

export const serveLayer = (settings: {
  readonly host: string
  readonly port: number
  readonly dataDirectory: string
  readonly configRepositoryUrl: string
  readonly serverUrl: string
}) =>
  HttpRouter.serve(apiLayer(settings), {
    disableLogger: true,
    middleware: logRequestWithClientVersion,
  }).pipe(Layer.provide(BunHttpServer.layer({ hostname: settings.host, port: settings.port })))
