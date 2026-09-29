import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpApiClient from 'effect/unstable/httpapi/HttpApiClient'
import packageJson from '../../package.json' with { type: 'json' }
import { CLIENT_VERSION_HEADER, PieApi } from '../Api.ts'
import { configHome } from '../Pod.ts'

const TOKEN_FILE_NAME = 'token'

const SERVER_URL_FILE_NAME = 'url'

const PRIVATE_DIRECTORY_MODE = 0o700

const PRIVATE_FILE_MODE = 0o600

export class NotJoined extends Schema.TaggedError<NotJoined>()('NotJoined', {
  configDirectory: Schema.String,
}) {
  override get message(): string {
    return `This machine hasn't joined pie yet: ${this.configDirectory} has no token. Run \`pie join <invite>\` first.`
  }
}

const pieConfigDirectory = configHome.pipe(
  Config.map((configDirectory) => `${configDirectory}/pie`),
)

export class PieClient extends Context.Service<PieClient>()('pie/PieClient', {
  make: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const httpClient = yield* HttpClient.HttpClient

    const credentialPaths = Effect.gen(function* () {
      const configDirectory = yield* pieConfigDirectory

      return {
        configDirectory,
        tokenPath: path.join(configDirectory, TOKEN_FILE_NAME),
        serverUrlPath: path.join(configDirectory, SERVER_URL_FILE_NAME),
      }
    })

    const forServer = (serverUrl: string, token: Option.Option<string>) =>
      HttpApiClient.make(PieApi, {
        baseUrl: serverUrl,
        transformClient: HttpClient.mapRequest((request) =>
          Option.match(token, {
            onNone: () => request,
            onSome: (bearerToken) => HttpClientRequest.bearerToken(request, bearerToken),
          }).pipe(HttpClientRequest.setHeader(CLIENT_VERSION_HEADER, packageJson.version)),
        ),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))

    const joined = Effect.gen(function* () {
      const { configDirectory, tokenPath, serverUrlPath } = yield* credentialPaths
      const tokenExists = yield* fileSystem.exists(tokenPath)
      const serverUrlExists = yield* fileSystem.exists(serverUrlPath)

      if (tokenExists && serverUrlExists) {
        const token = (yield* fileSystem.readFileString(tokenPath)).trim()
        const serverUrl = (yield* fileSystem.readFileString(serverUrlPath)).trim()

        return yield* forServer(serverUrl, Option.some(token))
      }

      return yield* new NotJoined({ configDirectory })
    })

    const saveCredentials = Effect.fn('PieClient.saveCredentials')(function* (
      serverUrl: string,
      token: string,
    ) {
      const { configDirectory, tokenPath, serverUrlPath } = yield* credentialPaths

      yield* fileSystem.makeDirectory(configDirectory, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      })
      yield* fileSystem.remove(tokenPath, { force: true })
      yield* fileSystem.writeFileString(tokenPath, `${token}\n`, { mode: PRIVATE_FILE_MODE })
      yield* fileSystem.writeFileString(serverUrlPath, `${serverUrl}\n`)
    })

    return { forServer, joined, saveCredentials }
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
