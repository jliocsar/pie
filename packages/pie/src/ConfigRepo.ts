import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import type * as SchemaAST from 'effect/SchemaAST'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import { isValidTag, RECIPE_TAG_PREFIX } from './ExeDev.ts'

export type ConfigNames = Record.ReadonlyRecord<ReferenceKind, readonly string[]>

type EnvironmentResolution = Effect.Effect<
  ResolvedEnvironment,
  ConfigReferenceMissing | EnvironmentExtendsCycle
>

const FRONTMATTER_PATTERN = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u
const TOML_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'error' }
const FRONTMATTER_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'ignore' }

export const SCHEMA_DIRECTORY = '.pie/schema'

const PIE_OWNED_HOME_PATHS = [
  '.claude',
  '.claude.json',
  '.config/pie',
  '.config/mise',
  '.cache/pie',
  '.local/bin/pie',
  '.local/bin/mise',
  '.local/share/mise',
  'workspace',
]

const APPEND_ONLY_HOME_PATHS = ['.profile', '.zshrc']

export const ReferenceKind = Schema.Literals([
  'environment',
  'agent',
  'settings',
  'skill',
  'mcp',
  'task',
  'home',
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

export const ResolvedEnvironment = Schema.Struct({
  label: Schema.String,
  tools: Schema.Record(Schema.String, ToolRequest),
  env: Schema.Record(Schema.String, Schema.String),
  tasks: Schema.Array(nameOf('task')),
})

export type ResolvedEnvironment = typeof ResolvedEnvironment.Type

export const Environment = Schema.Struct({
  extends: Schema.optionalKey(nameOf('environment')),
  label: ResolvedEnvironment.fields.label,
  tools: ResolvedEnvironment.fields.tools.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  env: ResolvedEnvironment.fields.env.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  tasks: Schema.optionalKey(ResolvedEnvironment.fields.tasks),
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

const HomeName = nameOf('home')

const HomeSetTable = Schema.Struct({
  name: HomeName,
  mode: Schema.Literals(['copy', 'append']),
})

export const HomeSet = Schema.Union([
  HomeName.pipe(
    Schema.decodeTo(
      HomeSetTable,
      SchemaTransformation.transform({
        decode: (name: string): typeof HomeSetTable.Type => ({ name, mode: 'copy' }),
        encode: (homeSet) => homeSet.name,
      }),
    ),
  ),
  HomeSetTable,
])

export type HomeSet = typeof HomeSet.Type

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
  home: Schema.optionalKey(Schema.Array(HomeSet)),
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
  name: Schema.NonEmptyString,
  description: Schema.String,
})

export type Frontmatter = typeof Frontmatter.Type

export const ClaudeSettings = Schema.Record(Schema.String, Schema.Unknown)

export type ClaudeSettings = typeof ClaudeSettings.Type

const ClaudeSettingsJson = Schema.fromJsonString(ClaudeSettings)

const Config = Schema.Struct({
  environments: Schema.Record(Schema.String, ResolvedEnvironment),
  recipes: Schema.Record(Schema.String, Recipe),
  mcpServers: Schema.Record(Schema.String, McpServer),
  agents: Schema.Record(Schema.String, Frontmatter),
  settings: Schema.Record(Schema.String, ClaudeSettings),
  skills: Schema.Record(Schema.String, Frontmatter),
  tasks: Schema.Array(Schema.String),
  homeSets: Schema.Record(Schema.String, Schema.Array(Schema.String)),
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
  home: (homeName: string) => `home/${homeName}`,
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

export class EnvironmentExtendsCycle extends Schema.TaggedError<EnvironmentExtendsCycle>()(
  'EnvironmentExtendsCycle',
  {
    filePath: Schema.String,
    environmentNames: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `${this.filePath} extends itself through ${this.environmentNames.join(' -> ')}. Remove one of those extends.`
  }
}

export class RecipeNameNotTaggable extends Schema.TaggedError<RecipeNameNotTaggable>()(
  'RecipeNameNotTaggable',
  {
    recipeName: Schema.String,
  },
) {
  override get message(): string {
    return `${configFilePathOf.recipe(this.recipeName)} can't name a recipe, since ${RECIPE_TAG_PREFIX}${this.recipeName} isn't a valid exe.dev tag. Rename it using only a-z, 0-9, _ and -.`
  }
}

export class HomePathPieOwned extends Schema.TaggedError<HomePathPieOwned>()('HomePathPieOwned', {
  filePath: Schema.String,
  homePath: Schema.String,
}) {
  override get message(): string {
    return `${this.filePath} would land on ~/${this.homePath}, which pie writes itself. Set it through a recipe or an environment instead.`
  }
}

export class HomeFileAppendOnly extends Schema.TaggedError<HomeFileAppendOnly>()(
  'HomeFileAppendOnly',
  {
    filePath: Schema.String,
    homeName: Schema.String,
    homePath: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} copies ~/${this.homePath} from home set "${this.homeName}", but pie adds its own lines there, so it can only be appended to. List it as { name = "${this.homeName}", mode = "append" }.`
  }
}

export class HomePathsOverlap extends Schema.TaggedError<HomePathsOverlap>()('HomePathsOverlap', {
  filePath: Schema.String,
  homePath: Schema.String,
  homeNames: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `${this.filePath} lists home sets ${this.homeNames.join(' and ')}, which both write ~/${this.homePath}. Only append sets can share a file.`
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

  return pipe(
    fileNames,
    Arr.filter((fileName) => path.extname(fileName) === extension),
    Arr.map((fileName) => path.basename(fileName, extension)),
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
    home: yield* listDirectory(configDirectory, 'home', 'Directory', { recursive: false }),
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
) {
  const text = yield* readConfigFile(configDirectory, filePath)

  return yield* extractFrontmatter(filePath, text)
})

const loadAgents = (configDirectory: string, agentNames: readonly string[]) =>
  Effect.forEach(agentNames, (agentName) =>
    loadFrontmatter(configDirectory, configFilePathOf.agent(agentName)).pipe(
      Effect.map((frontmatter) => [agentName, frontmatter] as const),
    ),
  ).pipe(Effect.map(Record.fromEntries))

const loadSkill = Effect.fn('loadSkill')(function* (configDirectory: string, skillName: string) {
  const filePath = configFilePathOf.skill(skillName)
  const frontmatter = yield* loadFrontmatter(configDirectory, filePath)

  if (frontmatter.name !== skillName) {
    return yield* new ConfigNameMismatch({
      filePath,
      declaredName: frontmatter.name,
      expectedName: skillName,
    })
  }

  return [skillName, frontmatter] as const
})

const loadSkills = (configDirectory: string, skillNames: readonly string[]) =>
  Effect.forEach(skillNames, (skillName) => loadSkill(configDirectory, skillName)).pipe(
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

const isPieOwnedHomePath = (homePath: string) =>
  Arr.some(
    PIE_OWNED_HOME_PATHS,
    (pieOwnedPath) => homePath === pieOwnedPath || homePath.startsWith(`${pieOwnedPath}/`),
  )

const loadHomeSets = (configDirectory: string, homeNames: readonly string[]) =>
  Effect.forEach(homeNames, (homeName) =>
    listDirectory(configDirectory, configFilePathOf.home(homeName), 'File', {
      recursive: true,
    }).pipe(
      Effect.tap((homePaths) =>
        Option.match(Arr.findFirst(homePaths, isPieOwnedHomePath), {
          onNone: () => Effect.void,
          onSome: (homePath) =>
            Effect.fail(
              new HomePathPieOwned({
                filePath: `${configFilePathOf.home(homeName)}/${homePath}`,
                homePath,
              }),
            ),
        }),
      ),
      Effect.map((homePaths) => [homeName, homePaths] as const),
    ),
  ).pipe(Effect.map(Record.fromEntries))

const lookUpReference =
  <Value>(
    filePath: string,
    referenceKind: ReferenceKind,
    entries: Record.ReadonlyRecord<string, Value>,
  ) =>
  (referenceName: string): Effect.Effect<Value, ConfigReferenceMissing> =>
    Option.match(Record.get(entries, referenceName), {
      onNone: () =>
        Effect.fail(new ConfigReferenceMissing({ filePath, referenceKind, referenceName })),
      onSome: Effect.succeed,
    })

const checkEnvironment = (
  taskNames: readonly string[],
  environmentName: string,
  environment: Environment,
) =>
  Effect.forEach(
    Option.getOrElse(Option.fromUndefinedOr(environment.tasks), Arr.empty),
    lookUpReference(
      configFilePathOf.environment(environmentName),
      'task',
      Record.fromIterableWith(taskNames, (taskName) => [taskName, taskName]),
    ),
    { discard: true },
  )

const ROOT_ENVIRONMENT: ResolvedEnvironment = { label: '', tools: {}, env: {}, tasks: [] }

const resolveParentEnvironment = (
  environments: Record.ReadonlyRecord<string, Environment>,
  environmentChain: Arr.NonEmptyReadonlyArray<string>,
  parentName: string,
): EnvironmentResolution =>
  Option.match(
    Arr.findFirstIndex(environmentChain, (environmentName) => environmentName === parentName),
    {
      onNone: () =>
        lookUpReference(
          configFilePathOf.environment(Arr.lastNonEmpty(environmentChain)),
          'environment',
          environments,
        )(parentName).pipe(
          Effect.flatMap((parent) =>
            resolveEnvironment(environments, Arr.append(environmentChain, parentName), parent),
          ),
        ),
      onSome: (cycleStartIndex) =>
        Effect.fail(
          new EnvironmentExtendsCycle({
            filePath: configFilePathOf.environment(parentName),
            environmentNames: pipe(
              environmentChain,
              Arr.drop(cycleStartIndex),
              Arr.append(parentName),
            ),
          }),
        ),
    },
  )

const resolveEnvironment = (
  environments: Record.ReadonlyRecord<string, Environment>,
  environmentChain: Arr.NonEmptyReadonlyArray<string>,
  environment: Environment,
): EnvironmentResolution =>
  Option.match(Option.fromUndefinedOr(environment.extends), {
    onNone: (): EnvironmentResolution => Effect.succeed(ROOT_ENVIRONMENT),
    onSome: (parentName) => resolveParentEnvironment(environments, environmentChain, parentName),
  }).pipe(
    Effect.map((parent) => ({
      label: environment.label,
      tools: { ...parent.tools, ...environment.tools },
      env: { ...parent.env, ...environment.env },
      tasks: Option.getOrElse(Option.fromUndefinedOr(environment.tasks), () => parent.tasks),
    })),
  )

const resolveRecipe = Effect.fn('resolveRecipe')(function* (
  config: Config,
  recipeName: string,
  recipe: Recipe,
) {
  const filePath = configFilePathOf.recipe(recipeName)

  yield* Effect.fail(new RecipeNameNotTaggable({ recipeName })).pipe(
    Effect.when(Effect.succeed(!isValidTag(`${RECIPE_TAG_PREFIX}${recipeName}`))),
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

  const homeFiles = Arr.flatten(
    yield* Effect.forEach(
      Option.getOrElse(Option.fromUndefinedOr(recipe.home), Arr.empty),
      (homeSet) =>
        Effect.map(
          lookUpReference(filePath, 'home', config.homeSets)(homeSet.name),
          Arr.map((homePath) => ({
            homeName: homeSet.name,
            mode: homeSet.mode,
            sourcePath: `${configFilePathOf.home(homeSet.name)}/${homePath}`,
            homePath,
          })),
        ),
    ),
  )

  yield* Option.match(
    Arr.findFirst(
      homeFiles,
      (homeFile) =>
        homeFile.mode === 'copy' && Arr.contains(APPEND_ONLY_HOME_PATHS, homeFile.homePath),
    ),
    {
      onNone: () => Effect.void,
      onSome: ({ homeName, homePath }) =>
        Effect.fail(new HomeFileAppendOnly({ filePath, homeName, homePath })),
    },
  )
  yield* Option.match(
    Arr.findFirst(
      homeFiles,
      (homeFile) =>
        homeFile.mode === 'copy' &&
        Arr.some(
          homeFiles,
          (otherHomeFile) =>
            otherHomeFile !== homeFile && otherHomeFile.homePath === homeFile.homePath,
        ),
    ),
    {
      onNone: () => Effect.void,
      onSome: ({ homePath }) =>
        Effect.fail(
          new HomePathsOverlap({
            filePath,
            homePath,
            homeNames: pipe(
              homeFiles,
              Arr.filter((homeFile) => homeFile.homePath === homePath),
              Arr.map((homeFile) => homeFile.homeName),
              Arr.dedupe,
            ),
          }),
        ),
    },
  )

  return {
    ...recipe,
    environment,
    home: homeFiles,
    mcp: mcpServers,
    claude: { agents: recipe.claude.agents, settings: claudeSettings },
  }
})

export type ResolvedRecipe = Effect.Success<ReturnType<typeof resolveRecipe>>

export const loadConfig = Effect.fn('loadConfig')(function* (configDirectory: string) {
  const configNames = yield* listConfigNames(configDirectory)
  const recipeNames = yield* listNamesByExtension(configDirectory, 'recipes', '.toml')
  const environments = yield* loadTomlFiles(
    configDirectory,
    configNames.environment,
    configFilePathOf.environment,
    Environment,
  )

  yield* Effect.forEach(
    Record.toEntries(environments),
    ([environmentName, environment]) =>
      checkEnvironment(configNames.task, environmentName, environment),
    { discard: true },
  )

  const config: Config = {
    environments: yield* Effect.all(
      Record.map(environments, (environment, environmentName) =>
        resolveEnvironment(environments, [environmentName], environment),
      ),
    ),
    recipes: yield* loadTomlFiles(configDirectory, recipeNames, configFilePathOf.recipe, Recipe),
    mcpServers: yield* loadTomlFiles(
      configDirectory,
      configNames.mcp,
      configFilePathOf.mcp,
      McpServer,
    ),
    agents: yield* loadAgents(configDirectory, configNames.agent),
    settings: yield* loadSettings(configDirectory, configNames.settings),
    skills: yield* loadSkills(configDirectory, configNames.skill),
    tasks: configNames.task,
    homeSets: yield* loadHomeSets(configDirectory, configNames.home),
  }

  const recipes = yield* Effect.all(
    Record.map(config.recipes, (recipe, recipeName) => resolveRecipe(config, recipeName, recipe)),
  )

  return { ...config, recipes }
})
