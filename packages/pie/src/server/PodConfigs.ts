import * as Arr from 'effect/Array'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import { type ClaudeMcpServer, type Device, PodHasNoRecipe, RecipeNotFound } from '../Api.ts'
import {
  configFilePathOf,
  ConfigReferenceMissing,
  type Environment,
  HttpMcpServer,
  listDirectory,
  loadConfig,
  type McpServer,
  type ReferenceKind,
  type ToolRequest,
} from '../Config.ts'
import { ConfigRepository } from './ConfigRepository.ts'

const EXECUTABLE_MODE_BITS = 0o111

const MISE_TOOLS_TABLE = '[tools]'

const tomlInlineTableOf = (toolRequest: ToolRequest) =>
  `{ ${Arr.map(
    Record.toEntries(toolRequest),
    ([optionName, optionValue]) => `${JSON.stringify(optionName)} = ${JSON.stringify(optionValue)}`,
  ).join(', ')} }`

const miseConfigOf = (environment: Environment) =>
  [
    MISE_TOOLS_TABLE,
    ...Arr.map(
      Record.toEntries(environment.tools),
      ([toolName, toolRequest]) =>
        `${JSON.stringify(toolName)} = ${tomlInlineTableOf(toolRequest)}`,
    ),
    '',
  ].join('\n')

const isHttpMcpServer = Schema.is(HttpMcpServer)

const claudeMcpServerOf = (mcpServer: McpServer): ClaudeMcpServer =>
  isHttpMcpServer(mcpServer)
    ? { type: 'http', url: mcpServer.url }
    : { type: 'stdio', command: mcpServer.command, args: mcpServer.args }

const lookUpRecipeReference = <Value>(
  recipeName: string,
  referenceKind: ReferenceKind,
  entries: Record.ReadonlyRecord<string, Value>,
  referenceName: string,
): Effect.Effect<Value, ConfigReferenceMissing> =>
  Option.match(Record.get(entries, referenceName), {
    onNone: () =>
      Effect.fail(
        new ConfigReferenceMissing({
          filePath: configFilePathOf.recipe(recipeName),
          referenceKind,
          referenceName,
        }),
      ),
    onSome: Effect.succeed,
  })

const readPodFile = Effect.fn('readPodFile')(function* (
  configDirectory: string,
  filePath: string,
  podPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absoluteFilePath = path.join(configDirectory, filePath)
  const content = yield* fileSystem.readFile(absoluteFilePath)
  const fileInfo = yield* fileSystem.stat(absoluteFilePath)

  return { path: podPath, content, executable: (fileInfo.mode & EXECUTABLE_MODE_BITS) !== 0 }
})

const readRepositoryFile = (configDirectory: string, filePath: string) =>
  readPodFile(configDirectory, filePath, filePath)

const readSkillFiles = Effect.fn('readSkillFiles')(function* (
  configDirectory: string,
  skillName: string,
) {
  const path = yield* Path.Path
  const skillDirectory = path.dirname(configFilePathOf.skill(skillName))
  const skillFilePaths = yield* listDirectory(configDirectory, skillDirectory, 'File', {
    recursive: true,
  })

  return yield* Effect.forEach(skillFilePaths, (skillFilePath) =>
    readRepositoryFile(configDirectory, path.join(skillDirectory, skillFilePath)),
  )
})

const podConfigOf = Effect.fn('podConfigOf')(function* (
  configDirectory: string,
  recipeName: string,
  commit: string,
) {
  const config = yield* loadConfig(configDirectory)
  const recipe = yield* Option.match(Record.get(config.recipes, recipeName), {
    onNone: () => Effect.fail(new RecipeNotFound({ recipeName })),
    onSome: Effect.succeed,
  })
  const environment = yield* lookUpRecipeReference(
    recipeName,
    'environment',
    config.environments,
    recipe.environment,
  )
  const mcpServerEntries = yield* Effect.forEach(recipe.mcp, (mcpName) =>
    lookUpRecipeReference(recipeName, 'mcp', config.mcpServers, mcpName).pipe(
      Effect.map((mcpServer) => [mcpName, claudeMcpServerOf(mcpServer)] as const),
    ),
  )
  const agentFiles = yield* Effect.forEach(recipe.agents, (agentName) =>
    readRepositoryFile(configDirectory, configFilePathOf.agent(agentName)),
  )
  const skillFiles = yield* Effect.forEach(recipe.skills, (skillName) =>
    readSkillFiles(configDirectory, skillName),
  )
  const tasks = yield* Effect.forEach(environment.tasks, (taskName) =>
    readPodFile(configDirectory, configFilePathOf.task(taskName), taskName),
  )

  return {
    commit,
    miseConfig: miseConfigOf(environment),
    tasks,
    repositories: recipe.repositories,
    claudeFiles: [...agentFiles, ...Arr.flatten(skillFiles)],
    mcpServers: Record.fromEntries(mcpServerEntries),
  }
})

export class PodConfigs extends Context.Service<PodConfigs>()('pie/PodConfigs', {
  make: Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const configRepository = yield* ConfigRepository

    const forDevice = Effect.fn('PodConfigs.forDevice')(function* (device: Device) {
      const recipeName = yield* Option.match(device.recipe, {
        onNone: () => Effect.fail(new PodHasNoRecipe({ deviceName: device.name })),
        onSome: Effect.succeed,
      })
      const commit = yield* configRepository.headCommit

      return yield* podConfigOf(configRepository.checkoutDirectory, recipeName, commit)
    }, Effect.provide(services))

    return { forDevice }
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
