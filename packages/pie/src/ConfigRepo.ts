import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import type * as SchemaAST from 'effect/SchemaAST'
import * as SchemaTransformation from 'effect/SchemaTransformation'

export type ConfigNames = Record.ReadonlyRecord<ReferenceKind, readonly string[]>

const FRONTMATTER_PATTERN = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u

const TOML_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'error' }

const FRONTMATTER_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'ignore' }

const TAGGABLE_RECIPE_NAME_PATTERN = /^[a-z0-9_-]+$/u

export const SCHEMA_DIRECTORY = '.pie/schema'

export const ReferenceKind = Schema.Literals([
  'environment',
  'agent',
  'settings',
  'skill',
  'mcp',
  'task',
])

export type ReferenceKind = typeof ReferenceKind.Type

const nameOf = (referenceKind: ReferenceKind) =>
  Schema.String.annotate({ identifier: referenceKind })

const withEmptyDefault = <Item extends Schema.Top>(item: Item) =>
  Schema.Array(item).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

const namesOf = (referenceKind: ReferenceKind) => withEmptyDefault(nameOf(referenceKind))

const ToolRequestTable = Schema.StructWithRest(Schema.Struct({ version: Schema.String }), [
  Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Int, Schema.Boolean])),
])

export const ToolRequest = Schema.Union([
  Schema.String.pipe(
    Schema.decodeTo(
      ToolRequestTable,
      SchemaTransformation.transform({
        decode: (version: string) => ({ version }),
        encode: (toolRequest) => toolRequest.version,
      }),
    ),
  ),
  ToolRequestTable,
])

export type ToolRequest = typeof ToolRequest.Type

export const Environment = Schema.Struct({
  label: Schema.String,
  tools: Schema.Record(Schema.String, ToolRequest),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  tasks: namesOf('task'),
})

export type Environment = typeof Environment.Type

export const RepositoryName = Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/u))

const RepositoryCheckout = Schema.Struct({ repo: RepositoryName, dir: Schema.String })

export const Repository = Schema.Union([
  RepositoryName.pipe(
    Schema.decodeTo(
      RepositoryCheckout,
      SchemaTransformation.transform({
        decode: (repo: string) => ({ repo, dir: repo }),
        encode: (checkout) => checkout.repo,
      }),
    ),
  ),
  RepositoryCheckout,
])

export type Repository = typeof Repository.Type

const ClaudeRecipe = Schema.Struct({
  agents: namesOf('agent'),
  settings: Schema.optionalKey(nameOf('settings')),
})

export const Recipe = Schema.Struct({
  label: Schema.String,
  environment: nameOf('environment'),
  repositories: withEmptyDefault(Repository),
  skills: namesOf('skill'),
  mcp: namesOf('mcp'),
  claude: ClaudeRecipe.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
})

export type Recipe = typeof Recipe.Type

export const HttpMcpServer = Schema.Struct({ url: Schema.String })

export const StdioMcpServer = Schema.Struct({
  command: Schema.String,
  args: withEmptyDefault(Schema.String),
})

export const McpServer = Schema.Union([HttpMcpServer, StdioMcpServer])

export type McpServer = typeof McpServer.Type

export const Frontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})

export type Frontmatter = typeof Frontmatter.Type

export const ClaudeSettings = Schema.Record(Schema.String, Schema.Unknown)

export type ClaudeSettings = typeof ClaudeSettings.Type

const ClaudeSettingsJson = Schema.fromJsonString(ClaudeSettings)

const Config = Schema.Struct({
  environments: Schema.Record(Schema.String, Environment),
  recipes: Schema.Record(Schema.String, Recipe),
  mcpServers: Schema.Record(Schema.String, McpServer),
  agents: Schema.Record(Schema.String, Frontmatter),
  settings: Schema.Record(Schema.String, ClaudeSettings),
  skills: Schema.Record(Schema.String, Frontmatter),
  tasks: Schema.Array(Schema.String),
})

type Config = typeof Config.Type

export const tomlSchemas = { recipe: Recipe, environment: Environment, mcp: McpServer }

export type TomlKind = keyof typeof tomlSchemas

export const configFilePathOf = {
  environment: (environmentName: string) => `environments/${environmentName}.toml`,
  recipe: (recipeName: string) => `recipes/${recipeName}.toml`,
  mcp: (mcpName: string) => `mcp/${mcpName}.toml`,
  agent: (agentName: string) => `claude/agents/${agentName}.md`,
  settings: (settingsName: string) => `claude/settings/${settingsName}.json`,
  skill: (skillName: string) => `skills/${skillName}/SKILL.md`,
  task: (taskName: string) => `tasks/${taskName}`,
  schema: (tomlKind: TomlKind) => `${SCHEMA_DIRECTORY}/${tomlKind}.json`,
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

export class RecipeNameNotTaggable extends Schema.TaggedError<RecipeNameNotTaggable>()(
  'RecipeNameNotTaggable',
  {
    recipeName: Schema.String,
  },
) {
  override get message(): string {
    return `${configFilePathOf.recipe(this.recipeName)} can't name a recipe, since pie-recipe-${this.recipeName} isn't a valid exe.dev tag. Rename it using only a-z, 0-9, _ and -.`
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

export const listDirectory = Effect.fn('listDirectory')(function* (
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

export const listConfigNames = Effect.fn('listConfigNames')(function* (configDirectory: string) {
  const configNames: ConfigNames = {
    environment: yield* listNamesByExtension(configDirectory, 'environments', '.toml'),
    agent: yield* listNamesByExtension(configDirectory, 'claude/agents', '.md'),
    settings: yield* listNamesByExtension(configDirectory, 'claude/settings', '.json'),
    skill: yield* listDirectory(configDirectory, 'skills', 'Directory', { recursive: false }),
    mcp: yield* listNamesByExtension(configDirectory, 'mcp', '.toml'),
    task: yield* listDirectory(configDirectory, 'tasks', 'File', { recursive: true }),
  }

  return configNames
})

const loadTomlFiles = <Decoded>(
  configDirectory: string,
  names: readonly string[],
  filePathOf: (name: string) => string,
  schema: Schema.Decoder<Decoded>,
) =>
  Effect.forEach(names, (name) => {
    const filePath = filePathOf(name)

    return readConfigFile(configDirectory, filePath).pipe(
      Effect.flatMap((text) =>
        decodeConfigText(Bun.TOML, schema, TOML_PARSE_OPTIONS)(filePath, text),
      ),
      Effect.map((decoded) => [name, decoded] as const),
    )
  }).pipe(Effect.map(Record.fromEntries))

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

const loadFrontmatters = (
  configDirectory: string,
  names: readonly string[],
  filePathOf: (name: string) => string,
) =>
  Effect.forEach(names, (name) => loadFrontmatter(configDirectory, filePathOf(name), name)).pipe(
    Effect.map(Record.fromEntries),
  )

const loadSettings = (configDirectory: string, settingsNames: readonly string[]) =>
  Effect.forEach(settingsNames, (settingsName) => {
    const filePath = configFilePathOf.settings(settingsName)

    return readConfigFile(configDirectory, filePath).pipe(
      Effect.flatMap(Schema.decodeEffect(ClaudeSettingsJson)),
      Effect.catchTag('SchemaError', (schemaError) =>
        Effect.fail(new ConfigFileInvalid({ filePath, issueMessage: schemaError.message })),
      ),
      Effect.map((claudeSettings) => [settingsName, claudeSettings] as const),
    )
  }).pipe(Effect.map(Record.fromEntries))

const lookUpReference =
  <Value>(
    filePath: string,
    referenceKind: ReferenceKind,
    entries: Record.ReadonlyRecord<string, Value>,
  ) =>
  (referenceName: string) =>
    Option.match(Record.get(entries, referenceName), {
      onNone: () =>
        Effect.fail(new ConfigReferenceMissing({ filePath, referenceKind, referenceName })),
      onSome: Effect.succeed,
    })

const checkEnvironment = (config: Config, environmentName: string, environment: Environment) =>
  Effect.forEach(
    environment.tasks,
    lookUpReference(
      configFilePathOf.environment(environmentName),
      'task',
      Record.fromIterableWith(config.tasks, (taskName) => [taskName, taskName]),
    ),
    { discard: true },
  )

const resolveRecipe = Effect.fn('resolveRecipe')(function* (
  config: Config,
  recipeName: string,
  recipe: Recipe,
) {
  const filePath = configFilePathOf.recipe(recipeName)

  yield* Effect.fail(new RecipeNameNotTaggable({ recipeName })).pipe(
    Effect.when(Effect.succeed(!TAGGABLE_RECIPE_NAME_PATTERN.test(recipeName))),
  )

  const environment = yield* lookUpReference(
    filePath,
    'environment',
    config.environments,
  )(recipe.environment)

  yield* Effect.forEach(recipe.claude.agents, lookUpReference(filePath, 'agent', config.agents), {
    discard: true,
  })

  const claudeSettings = yield* Option.match(Option.fromUndefinedOr(recipe.claude.settings), {
    onNone: () => Effect.succeed<ClaudeSettings>({}),
    onSome: lookUpReference(filePath, 'settings', config.settings),
  })

  yield* Effect.forEach(recipe.skills, lookUpReference(filePath, 'skill', config.skills), {
    discard: true,
  })

  const mcpServers = yield* Effect.all(
    Record.fromIterableWith(recipe.mcp, (mcpName) => [
      mcpName,
      lookUpReference(filePath, 'mcp', config.mcpServers)(mcpName),
    ]),
  )

  return {
    ...recipe,
    environment,
    mcp: mcpServers,
    claude: { agents: recipe.claude.agents, settings: claudeSettings },
  }
})

export type ResolvedRecipe = Effect.Success<ReturnType<typeof resolveRecipe>>

export const loadConfig = Effect.fn('loadConfig')(function* (configDirectory: string) {
  const configNames = yield* listConfigNames(configDirectory)
  const recipeNames = yield* listNamesByExtension(configDirectory, 'recipes', '.toml')
  const config: Config = {
    environments: yield* loadTomlFiles(
      configDirectory,
      configNames.environment,
      configFilePathOf.environment,
      Environment,
    ),
    recipes: yield* loadTomlFiles(configDirectory, recipeNames, configFilePathOf.recipe, Recipe),
    mcpServers: yield* loadTomlFiles(
      configDirectory,
      configNames.mcp,
      configFilePathOf.mcp,
      McpServer,
    ),
    agents: yield* loadFrontmatters(configDirectory, configNames.agent, configFilePathOf.agent),
    settings: yield* loadSettings(configDirectory, configNames.settings),
    skills: yield* loadFrontmatters(configDirectory, configNames.skill, configFilePathOf.skill),
    tasks: configNames.task,
  }

  yield* Effect.forEach(
    Record.toEntries(config.environments),
    ([environmentName, environment]) => checkEnvironment(config, environmentName, environment),
    { discard: true },
  )
  const recipes = yield* Effect.all(
    Record.map(config.recipes, (recipe, recipeName) => resolveRecipe(config, recipeName, recipe)),
  )

  return { ...config, recipes }
})
