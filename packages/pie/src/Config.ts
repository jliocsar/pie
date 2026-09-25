import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import type * as SchemaAST from 'effect/SchemaAST'

const FRONTMATTER_PATTERN = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u

const TOML_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'error' }

const FRONTMATTER_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'ignore' }

const Names = Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

export const Environment = Schema.Struct({
  label: Schema.String,
  tools: Schema.Record(Schema.String, Schema.String),
  tasks: Names,
})

export type Environment = typeof Environment.Type

export const RepositoryName = Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/u))

export const Repository = Schema.Union([
  RepositoryName,
  Schema.Struct({ repo: RepositoryName, dir: Schema.String }),
])

export type Repository = typeof Repository.Type

export const Recipe = Schema.Struct({
  label: Schema.String,
  environment: Schema.String,
  repositories: Schema.Array(Repository).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  agents: Names,
  skills: Names,
  mcp: Names,
})

export type Recipe = typeof Recipe.Type

export const HttpMcpServer = Schema.Struct({
  url: Schema.String,
  auth: Schema.optionalKey(Schema.String),
})

export const StdioMcpServer = Schema.Struct({
  command: Schema.String,
  args: Names,
})

export const McpServer = Schema.Union([HttpMcpServer, StdioMcpServer])

export type McpServer = typeof McpServer.Type

export const Frontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})

export type Frontmatter = typeof Frontmatter.Type

export const Config = Schema.Struct({
  environments: Schema.Record(Schema.String, Environment),
  recipes: Schema.Record(Schema.String, Recipe),
  mcpServers: Schema.Record(Schema.String, McpServer),
  agents: Schema.Record(Schema.String, Frontmatter),
  skills: Schema.Record(Schema.String, Frontmatter),
  tasks: Schema.Array(Schema.String),
})

export type Config = typeof Config.Type

export const ReferenceKind = Schema.Literals(['environment', 'agent', 'skill', 'mcp', 'task'])

export type ReferenceKind = typeof ReferenceKind.Type

const configFilePathOf = {
  environment: (environmentName: string) => `environments/${environmentName}.toml`,
  recipe: (recipeName: string) => `recipes/${recipeName}.toml`,
  mcp: (mcpName: string) => `mcp/${mcpName}.toml`,
  agent: (agentName: string) => `agents/${agentName}.md`,
  skill: (skillName: string) => `skills/${skillName}/SKILL.md`,
  task: (taskName: string) => `tasks/${taskName}`,
}

export class ConfigFileUnparseable extends Schema.TaggedError<ConfigFileUnparseable>()(
  'ConfigFileUnparseable',
  {
    filePath: Schema.String,
    parserMessage: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} doesn't parse: ${this.parserMessage}`
  }
}

export class FrontmatterMissing extends Schema.TaggedError<FrontmatterMissing>()(
  'FrontmatterMissing',
  {
    filePath: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} has no frontmatter. Start it with a --- block holding at least name and description.`
  }
}

export class ConfigFileInvalid extends Schema.TaggedError<ConfigFileInvalid>()(
  'ConfigFileInvalid',
  {
    filePath: Schema.String,
    issueMessage: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} is invalid:\n${this.issueMessage}`
  }
}

export class ConfigNameMismatch extends Schema.TaggedError<ConfigNameMismatch>()(
  'ConfigNameMismatch',
  {
    filePath: Schema.String,
    declaredName: Schema.String,
    expectedName: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} is named "${this.declaredName}", but its path names it "${this.expectedName}". Make them match.`
  }
}

export class ConfigReferenceMissing extends Schema.TaggedError<ConfigReferenceMissing>()(
  'ConfigReferenceMissing',
  {
    filePath: Schema.String,
    referenceKind: ReferenceKind,
    referenceName: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} lists ${this.referenceKind} "${this.referenceName}", but ${configFilePathOf[this.referenceKind](this.referenceName)} doesn't exist.`
  }
}

export class McpAuthNotSupportedYet extends Schema.TaggedError<McpAuthNotSupportedYet>()(
  'McpAuthNotSupportedYet',
  {
    filePath: Schema.String,
    mcpName: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} lists mcp "${this.mcpName}", which has auth, and pie can't inject MCP auth yet. Drop it from the recipe.`
  }
}

const decodeConfigText =
  <Decoded>(
    parser: typeof Bun.TOML | typeof Bun.YAML,
    schema: Schema.Decoder<Decoded>,
    parseOptions: SchemaAST.ParseOptions,
  ) =>
  (
    filePath: string,
    text: string,
  ): Effect.Effect<Decoded, ConfigFileUnparseable | ConfigFileInvalid> =>
    Effect.try({
      try: () => parser.parse(text),
      catch: (error) => new ConfigFileUnparseable({ filePath, parserMessage: String(error) }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema, parseOptions)),
      Effect.catchTag('SchemaError', (schemaError) =>
        Effect.fail(new ConfigFileInvalid({ filePath, issueMessage: schemaError.message })),
      ),
    )

const decodeFrontmatter = decodeConfigText(Bun.YAML, Frontmatter, FRONTMATTER_PARSE_OPTIONS)

const extractFrontmatter = (filePath: string, text: string) =>
  Option.fromNullishOr(FRONTMATTER_PATTERN.exec(text)?.groups?.['yaml']).pipe(
    Option.match({
      onNone: () => Effect.fail(new FrontmatterMissing({ filePath })),
      onSome: (yaml) => decodeFrontmatter(filePath, yaml),
    }),
  )

const listDirectory = Effect.fn('listDirectory')(function* (
  configDirectory: string,
  directoryName: string,
  entryType: FileSystem.File.Type,
  options: { readonly recursive: boolean },
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directoryPath = path.join(configDirectory, directoryName)
  const entryNames = (yield* fileSystem.exists(directoryPath))
    ? yield* fileSystem.readDirectory(directoryPath, options)
    : []
  const entryNamesOfType = yield* Effect.filter(entryNames, (entryName) =>
    Effect.map(
      fileSystem.stat(path.join(directoryPath, entryName)),
      (fileInfo) => fileInfo.type === entryType,
    ),
  )

  return Arr.sort(entryNamesOfType, Order.String)
})

const listNamesByExtension = Effect.fn('listNamesByExtension')(function* (
  configDirectory: string,
  directoryName: string,
  extension: string,
) {
  const path = yield* Path.Path
  const fileNames = yield* listDirectory(configDirectory, directoryName, 'File', {
    recursive: false,
  })

  return Arr.map(
    Arr.filter(fileNames, (fileName) => path.extname(fileName) === extension),
    (fileName) => path.basename(fileName, extension),
  )
})

const readConfigFile = Effect.fn('readConfigFile')(function* (
  configDirectory: string,
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return yield* fileSystem.readFileString(path.join(configDirectory, filePath))
})

const loadTomlDirectory = <Decoded>(
  configDirectory: string,
  directoryName: string,
  filePathOf: (name: string) => string,
  schema: Schema.Decoder<Decoded>,
) =>
  Effect.gen(function* () {
    const names = yield* listNamesByExtension(configDirectory, directoryName, '.toml')
    const entries = yield* Effect.forEach(names, (name) => {
      const filePath = filePathOf(name)

      return readConfigFile(configDirectory, filePath).pipe(
        Effect.flatMap((text) =>
          decodeConfigText(Bun.TOML, schema, TOML_PARSE_OPTIONS)(filePath, text),
        ),
        Effect.map((decoded) => [name, decoded] as const),
      )
    })

    return Record.fromEntries(entries)
  })

const loadFrontmatter = Effect.fn('loadFrontmatter')(function* (
  configDirectory: string,
  filePath: string,
  expectedName: string,
) {
  const text = yield* readConfigFile(configDirectory, filePath)
  const frontmatter = yield* extractFrontmatter(filePath, text)

  if (frontmatter.name !== expectedName) {
    return yield* new ConfigNameMismatch({
      filePath,
      declaredName: frontmatter.name,
      expectedName,
    })
  }

  return [expectedName, frontmatter] as const
})

const loadAgents = Effect.fn('loadAgents')(function* (configDirectory: string) {
  const agentNames = yield* listNamesByExtension(configDirectory, 'agents', '.md')
  const entries = yield* Effect.forEach(agentNames, (agentName) =>
    loadFrontmatter(configDirectory, configFilePathOf.agent(agentName), agentName),
  )

  return Record.fromEntries(entries)
})

const loadSkills = Effect.fn('loadSkills')(function* (configDirectory: string) {
  const skillNames = yield* listDirectory(configDirectory, 'skills', 'Directory', {
    recursive: false,
  })
  const entries = yield* Effect.forEach(skillNames, (skillName) =>
    loadFrontmatter(configDirectory, configFilePathOf.skill(skillName), skillName),
  )

  return Record.fromEntries(entries)
})

const requireReferences = (
  filePath: string,
  referenceKind: ReferenceKind,
  referenceNames: readonly string[],
  knownNames: readonly string[],
) =>
  Arr.findFirst(referenceNames, (referenceName) => !Arr.contains(knownNames, referenceName)).pipe(
    Option.match({
      onNone: () => Effect.void,
      onSome: (referenceName) =>
        Effect.fail(new ConfigReferenceMissing({ filePath, referenceKind, referenceName })),
    }),
  )

const hasAuth = Schema.is(Schema.Struct({ auth: Schema.String }))

const checkEnvironment = (config: Config, environmentName: string, environment: Environment) =>
  requireReferences(
    configFilePathOf.environment(environmentName),
    'task',
    environment.tasks,
    config.tasks,
  )

const checkRecipe = Effect.fn('checkRecipe')(function* (
  config: Config,
  recipeName: string,
  recipe: Recipe,
) {
  const filePath = configFilePathOf.recipe(recipeName)

  yield* requireReferences(
    filePath,
    'environment',
    [recipe.environment],
    Record.keys(config.environments),
  )
  yield* requireReferences(filePath, 'agent', recipe.agents, Record.keys(config.agents))
  yield* requireReferences(filePath, 'skill', recipe.skills, Record.keys(config.skills))
  yield* requireReferences(filePath, 'mcp', recipe.mcp, Record.keys(config.mcpServers))
  yield* Arr.findFirst(recipe.mcp, (mcpName) =>
    Option.exists(Record.get(config.mcpServers, mcpName), hasAuth),
  ).pipe(
    Option.match({
      onNone: () => Effect.void,
      onSome: (mcpName) => Effect.fail(new McpAuthNotSupportedYet({ filePath, mcpName })),
    }),
  )
})

export const loadConfig = Effect.fn('loadConfig')(function* (configDirectory: string) {
  const config: Config = {
    environments: yield* loadTomlDirectory(
      configDirectory,
      'environments',
      configFilePathOf.environment,
      Environment,
    ),
    recipes: yield* loadTomlDirectory(configDirectory, 'recipes', configFilePathOf.recipe, Recipe),
    mcpServers: yield* loadTomlDirectory(configDirectory, 'mcp', configFilePathOf.mcp, McpServer),
    agents: yield* loadAgents(configDirectory),
    skills: yield* loadSkills(configDirectory),
    tasks: yield* listDirectory(configDirectory, 'tasks', 'File', { recursive: true }),
  }

  yield* Effect.forEach(
    Record.toEntries(config.environments),
    ([environmentName, environment]) => checkEnvironment(config, environmentName, environment),
    { discard: true },
  )
  yield* Effect.forEach(
    Record.toEntries(config.recipes),
    ([recipeName, recipe]) => checkRecipe(config, recipeName, recipe),
    { discard: true },
  )

  return config
})
