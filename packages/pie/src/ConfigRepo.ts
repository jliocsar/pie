import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as JsonSchema from 'effect/JsonSchema'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import type * as SchemaAST from 'effect/SchemaAST'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import { GITHUB_INTEGRATION, isValidTag, RECIPE_TAG_PREFIX, RequiredTagName } from './ExeDev.ts'

type ConfigKind = ReferenceKind | 'recipe'

export type ConfigNames = Record.ReadonlyRecord<ConfigKind, readonly string[]>

interface ConfigLayout {
  readonly directory: string
  readonly entryType: FileSystem.File.Type
  readonly extension: string
  readonly indexPath: string
  readonly recursive: boolean
}

type ConfigParser = typeof Bun.TOML | typeof Bun.YAML | typeof JSON

interface ConfigFile {
  readonly content: Uint8Array
  readonly executable: boolean
}

export interface ClaudeFile extends ConfigFile {
  readonly claudePath: string
}

export interface TaskFile extends ConfigFile {
  readonly taskName: string
}

interface HomeSetFile extends ConfigFile {
  readonly homePath: string
}

export interface HomeFile extends HomeSetFile {
  readonly homeName: string
  readonly mode: HomeSet['mode']
}

interface Config {
  readonly environments: Record.ReadonlyRecord<string, ResolvedEnvironment>
  readonly recipes: Record.ReadonlyRecord<string, Recipe>
  readonly mcpServers: Record.ReadonlyRecord<string, McpServer>
  readonly agents: Record.ReadonlyRecord<string, ClaudeFile>
  readonly settings: Record.ReadonlyRecord<string, ClaudeSettings>
  readonly skills: Record.ReadonlyRecord<string, readonly ClaudeFile[]>
  readonly tasks: Record.ReadonlyRecord<string, ConfigFile>
  readonly homeSets: Record.ReadonlyRecord<string, readonly HomeSetFile[]>
  readonly claudeMd: Record.ReadonlyRecord<string, string>
}

type EnvironmentResolution = Effect.Effect<
  ResolvedEnvironment,
  ConfigReferenceMissing | EnvironmentExtendsCycle
>

const EXECUTABLE_MODE_BITS = 0o111
const FRONTMATTER_PATTERN = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u
const STRICT_PARSE_OPTIONS: SchemaAST.ParseOptions = { onExcessProperty: 'error' }
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

const CONFIG_LAYOUT: Record.ReadonlyRecord<ConfigKind, ConfigLayout> = {
  recipe: {
    directory: 'recipes',
    entryType: 'File',
    extension: '.toml',
    indexPath: '',
    recursive: false,
  },
  environment: {
    directory: 'environments',
    entryType: 'File',
    extension: '.toml',
    indexPath: '',
    recursive: false,
  },
  mcp: { directory: 'mcp', entryType: 'File', extension: '.toml', indexPath: '', recursive: false },
  agent: {
    directory: 'claude/agents',
    entryType: 'File',
    extension: '.md',
    indexPath: '',
    recursive: false,
  },
  settings: {
    directory: 'claude/settings',
    entryType: 'File',
    extension: '.json',
    indexPath: '',
    recursive: false,
  },
  claude_md: {
    directory: 'claude/claude_md',
    entryType: 'File',
    extension: '.md',
    indexPath: '',
    recursive: false,
  },
  skill: {
    directory: 'skills',
    entryType: 'Directory',
    extension: '',
    indexPath: '/SKILL.md',
    recursive: false,
  },
  task: { directory: 'tasks', entryType: 'File', extension: '', indexPath: '', recursive: true },
  home: {
    directory: 'home',
    entryType: 'Directory',
    extension: '',
    indexPath: '',
    recursive: false,
  },
}

export const ReferenceKind = Schema.Literals([
  'environment',
  'agent',
  'settings',
  'skill',
  'mcp',
  'task',
  'home',
  'claude_md',
])

export type ReferenceKind = typeof ReferenceKind.Type

const nameOf = (referenceKind: ReferenceKind) =>
  Schema.String.annotate({ identifier: referenceKind })

const withEmptyDefault = <Item extends Schema.Top>(item: Item) =>
  Schema.Array(item).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([])))

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

const RepositoryTable = Schema.Struct({
  repo: RepositoryName,
  dir: Schema.optionalKey(Schema.String),
  integration: Schema.optionalKey(Schema.String),
})

const RepositoryCheckout = Schema.Struct({
  repo: RepositoryName,
  dir: Schema.String,
  integration: Schema.String,
})

export const Repository = Schema.Union([
  RepositoryName.pipe(
    Schema.decodeTo(
      RepositoryTable,
      SchemaTransformation.transform({
        decode: (repo: string) => ({ repo }),
        encode: (repositoryTable) => repositoryTable.repo,
      }),
    ),
  ),
  RepositoryTable,
]).pipe(
  Schema.decodeTo(
    RepositoryCheckout,
    SchemaTransformation.transform({
      decode: ({
        repo,
        dir = repo,
        integration = GITHUB_INTEGRATION,
      }: typeof RepositoryTable.Type) => ({ repo, dir, integration }),
      encode: (checkout: typeof RepositoryCheckout.Type): typeof RepositoryTable.Type => checkout,
    }),
  ),
)

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
  claude_md: namesOf('claude_md'),
})

export const Recipe = Schema.Struct({
  label: Schema.String,
  tags: withEmptyDefault(RequiredTagName),
  environment: nameOf('environment'),
  repositories: withEmptyDefault(Repository),
  skills: namesOf('skill'),
  mcp: namesOf('mcp'),
  home: withEmptyDefault(HomeSet),
  claude: ClaudeRecipe.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
})

export type Recipe = typeof Recipe.Type

const HttpMcpServer = Schema.Struct({ type: Schema.Literal('http'), url: Schema.String })

const StdioMcpServer = Schema.Struct({
  type: Schema.Literal('stdio'),
  command: Schema.String,
  args: Schema.Array(Schema.String),
})

export const McpServer = Schema.Union([HttpMcpServer, StdioMcpServer])

const McpServerFile = Schema.Union([
  Schema.Struct({ url: HttpMcpServer.fields.url }).pipe(
    Schema.decodeTo(
      HttpMcpServer,
      SchemaTransformation.transform({
        decode: ({ url }): typeof HttpMcpServer.Type => ({ type: 'http', url }),
        encode: ({ url }) => ({ url }),
      }),
    ),
  ),
  Schema.Struct({
    command: StdioMcpServer.fields.command,
    args: withEmptyDefault(Schema.String),
  }).pipe(
    Schema.decodeTo(
      StdioMcpServer,
      SchemaTransformation.transform({
        decode: ({ command, args }): typeof StdioMcpServer.Type => ({
          type: 'stdio',
          command,
          args,
        }),
        encode: ({ command, args }) => ({ command, args }),
      }),
    ),
  ),
])

export type McpServer = typeof McpServer.Type

export const Frontmatter = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
})

export type Frontmatter = typeof Frontmatter.Type

export const ClaudeSettings = Schema.Record(Schema.String, Schema.Unknown)

export type ClaudeSettings = typeof ClaudeSettings.Type

export const tomlSchemas = { recipe: Recipe, environment: Environment, mcp: McpServerFile }

export type TomlKind = keyof typeof tomlSchemas

const configEntryPathOf = (configKind: ConfigKind, name: string) =>
  `${CONFIG_LAYOUT[configKind].directory}/${name}${CONFIG_LAYOUT[configKind].extension}`

export const configFilePathOf = (configKind: ConfigKind, name: string) =>
  `${configEntryPathOf(configKind, name)}${CONFIG_LAYOUT[configKind].indexPath}`

export const schemaFilePathOf = (tomlKind: TomlKind) => `${SCHEMA_DIRECTORY}/${tomlKind}.json`

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
    return `${this.filePath} lists ${this.referenceKind} "${this.referenceName}", but ${configFilePathOf(this.referenceKind, this.referenceName)} doesn't exist.`
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
    return `${configFilePathOf('recipe', this.recipeName)} can't name a recipe, since ${RECIPE_TAG_PREFIX}${this.recipeName} isn't a valid exe.dev tag. Rename it using only a-z, 0-9, _ and -.`
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
    parser: ConfigParser,
    schema: Schema.Decoder<Decoded>,
    parseOptions: SchemaAST.ParseOptions,
  ) =>
  (
    filePath: string,
    text: string,
  ): Effect.Effect<Decoded, ConfigFileUnparseable | ConfigFileInvalid> =>
    Effect.try({
      try: () => {
        const parsed: unknown = parser.parse(text)

        return parsed
      },
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

const listConfigEntries = Effect.fn('listConfigEntries')(function* (
  configDirectory: string,
  { directory, entryType, extension, recursive }: ConfigLayout,
) {
  const entryNames = yield* listDirectory(configDirectory, directory, entryType, { recursive })

  return pipe(
    entryNames,
    Arr.filter((entryName) => entryName.length > extension.length && entryName.endsWith(extension)),
    Arr.map((entryName) => entryName.slice(0, entryName.length - extension.length)),
  )
})

const readConfigText = Effect.fn('readConfigText')(function* (
  configDirectory: string,
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return yield* fileSystem.readFileString(path.join(configDirectory, filePath))
})

const readConfigFile = Effect.fn('readConfigFile')(function* (
  configDirectory: string,
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absoluteFilePath = path.join(configDirectory, filePath)
  const fileInfo = yield* fileSystem.stat(absoluteFilePath)
  const configFile: ConfigFile = {
    content: yield* fileSystem.readFile(absoluteFilePath),
    executable: (fileInfo.mode & EXECUTABLE_MODE_BITS) !== 0,
  }

  return configFile
})

const readConfigFilesIn = Effect.fn('readConfigFilesIn')(function* (
  configDirectory: string,
  directory: string,
) {
  const relativePaths = yield* listDirectory(configDirectory, directory, 'File', {
    recursive: true,
  })

  return yield* Effect.forEach(relativePaths, (relativePath) =>
    Effect.map(
      readConfigFile(configDirectory, `${directory}/${relativePath}`),
      (configFile) => [relativePath, configFile] as const,
    ),
  )
})

export const listConfigNames = Effect.fn('listConfigNames')(function* (configDirectory: string) {
  const configNames: ConfigNames = yield* Effect.all(
    Record.map(CONFIG_LAYOUT, (configLayout) => listConfigEntries(configDirectory, configLayout)),
  )

  return configNames
})

const renderJsonSchema = (schema: Schema.Top, configNames: ConfigNames) => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' })
  const definitions = Record.map(document.definitions, (definition, identifier) =>
    Option.match(Option.liftPredicate(identifier, Schema.is(ReferenceKind)), {
      onNone: () => definition,
      onSome: (referenceKind) => ({ type: 'string', enum: configNames[referenceKind] }),
    }),
  )

  return `${JSON.stringify(
    { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...document.schema, $defs: definitions },
    null,
    2,
  )}\n`
}

export const renderSchemaFiles = (configNames: ConfigNames) =>
  Record.fromEntries(
    Arr.map(
      Record.toEntries(tomlSchemas),
      ([tomlKind, schema]) =>
        [schemaFilePathOf(tomlKind), renderJsonSchema(schema, configNames)] as const,
    ),
  )

const loadEach = <Loaded, Failure, Requirements>(
  names: readonly string[],
  load: (name: string) => Effect.Effect<Loaded, Failure, Requirements>,
) =>
  Effect.forEach(names, (name) => Effect.map(load(name), (loaded) => [name, loaded] as const)).pipe(
    Effect.map(Record.fromEntries),
  )

const loadDecoded =
  <Decoded>(
    configDirectory: string,
    configKind: ConfigKind,
    parser: ConfigParser,
    schema: Schema.Decoder<Decoded>,
  ) =>
  (name: string) => {
    const filePath = configFilePathOf(configKind, name)

    return readConfigText(configDirectory, filePath).pipe(
      Effect.flatMap((text) =>
        decodeConfigText(parser, schema, STRICT_PARSE_OPTIONS)(filePath, text),
      ),
    )
  }

const loadAgent = Effect.fn('loadAgent')(function* (configDirectory: string, agentName: string) {
  const filePath = configFilePathOf('agent', agentName)
  const agentFile = yield* readConfigFile(configDirectory, filePath)

  yield* extractFrontmatter(filePath, new TextDecoder().decode(agentFile.content))

  const claudeFile: ClaudeFile = { claudePath: `agents/${agentName}.md`, ...agentFile }

  return claudeFile
})

const loadSkill = Effect.fn('loadSkill')(function* (configDirectory: string, skillName: string) {
  const filePath = configFilePathOf('skill', skillName)
  const frontmatter = yield* extractFrontmatter(
    filePath,
    yield* readConfigText(configDirectory, filePath),
  )

  if (frontmatter.name !== skillName) {
    return yield* new ConfigNameMismatch({
      filePath,
      declaredName: frontmatter.name,
      expectedName: skillName,
    })
  }

  const skillFiles = yield* readConfigFilesIn(
    configDirectory,
    configEntryPathOf('skill', skillName),
  )

  return Arr.map(skillFiles, ([skillPath, skillFile]): ClaudeFile => ({
    claudePath: `skills/${skillName}/${skillPath}`,
    ...skillFile,
  }))
})

const isPieOwnedHomePath = (homePath: string) =>
  Arr.some(
    PIE_OWNED_HOME_PATHS,
    (pieOwnedPath) => homePath === pieOwnedPath || homePath.startsWith(`${pieOwnedPath}/`),
  )

const loadHomeSet = Effect.fn('loadHomeSet')(function* (configDirectory: string, homeName: string) {
  const homeSetDirectory = configEntryPathOf('home', homeName)
  const homeSetFiles = yield* readConfigFilesIn(configDirectory, homeSetDirectory)

  return yield* Option.match(
    Arr.findFirst(homeSetFiles, ([homePath]) => isPieOwnedHomePath(homePath)),
    {
      onNone: () =>
        Effect.succeed(
          Arr.map(homeSetFiles, ([homePath, homeSetFile]): HomeSetFile => ({
            homePath,
            ...homeSetFile,
          })),
        ),
      onSome: ([homePath]) =>
        Effect.fail(
          new HomePathPieOwned({ filePath: `${homeSetDirectory}/${homePath}`, homePath }),
        ),
    },
  )
})

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
  taskFiles: Record.ReadonlyRecord<string, ConfigFile>,
  environmentName: string,
  environment: Environment,
) =>
  Effect.forEach(
    Option.getOrElse(Option.fromUndefinedOr(environment.tasks), Arr.empty),
    lookUpReference(configFilePathOf('environment', environmentName), 'task', taskFiles),
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
          configFilePathOf('environment', Arr.lastNonEmpty(environmentChain)),
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
            filePath: configFilePathOf('environment', parentName),
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
  const filePath = configFilePathOf('recipe', recipeName)

  if (!isValidTag(`${RECIPE_TAG_PREFIX}${recipeName}`)) {
    return yield* new RecipeNameNotTaggable({ recipeName })
  }

  const environment = yield* lookUpReference(
    filePath,
    'environment',
    config.environments,
  )(recipe.environment)

  const tasks = yield* Effect.forEach(environment.tasks, (taskName) =>
    Effect.map(
      lookUpReference(
        configFilePathOf('environment', recipe.environment),
        'task',
        config.tasks,
      )(taskName),
      (taskFile): TaskFile => ({ taskName, ...taskFile }),
    ),
  )
  const agentFiles = yield* Effect.forEach(
    recipe.claude.agents,
    lookUpReference(filePath, 'agent', config.agents),
  )

  const claudeSettings = yield* Option.match(Option.fromUndefinedOr(recipe.claude.settings), {
    onNone: () => Effect.succeed<ClaudeSettings>({}),
    onSome: lookUpReference(filePath, 'settings', config.settings),
  })

  const claudeMdTexts = yield* Effect.forEach(
    recipe.claude.claude_md,
    lookUpReference(filePath, 'claude_md', config.claudeMd),
  )

  const skillFiles = yield* Effect.forEach(
    recipe.skills,
    lookUpReference(filePath, 'skill', config.skills),
  )

  const mcpServers = yield* Effect.all(
    Record.fromIterableWith(recipe.mcp, (mcpName) => [
      mcpName,
      lookUpReference(filePath, 'mcp', config.mcpServers)(mcpName),
    ]),
  )

  const homeFiles = Arr.flatten(
    yield* Effect.forEach(recipe.home, (homeSet) =>
      Effect.map(
        lookUpReference(filePath, 'home', config.homeSets)(homeSet.name),
        Arr.map((homeSetFile): HomeFile => ({
          homeName: homeSet.name,
          mode: homeSet.mode,
          ...homeSetFile,
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
    label: recipe.label,
    tags: recipe.tags,
    environment,
    tasks,
    repositories: recipe.repositories,
    home: homeFiles,
    mcp: mcpServers,
    claude: {
      files: [...agentFiles, ...Arr.flatten(skillFiles)],
      settings: claudeSettings,
      claude_md: claudeMdTexts,
    },
  }
})

export type ResolvedRecipe = Effect.Success<ReturnType<typeof resolveRecipe>>

export const loadConfig = Effect.fn('loadConfig')(function* (configDirectory: string) {
  const configNames = yield* listConfigNames(configDirectory)
  const taskFiles = yield* loadEach(configNames.task, (taskName) =>
    readConfigFile(configDirectory, configFilePathOf('task', taskName)),
  )
  const environments = yield* loadEach(
    configNames.environment,
    loadDecoded(configDirectory, 'environment', Bun.TOML, Environment),
  )

  yield* Effect.forEach(
    Record.toEntries(environments),
    ([environmentName, environment]) => checkEnvironment(taskFiles, environmentName, environment),
    { discard: true },
  )

  const config: Config = {
    environments: yield* Effect.all(
      Record.map(environments, (environment, environmentName) =>
        resolveEnvironment(environments, [environmentName], environment),
      ),
    ),
    recipes: yield* loadEach(
      configNames.recipe,
      loadDecoded(configDirectory, 'recipe', Bun.TOML, Recipe),
    ),
    mcpServers: yield* loadEach(
      configNames.mcp,
      loadDecoded(configDirectory, 'mcp', Bun.TOML, McpServerFile),
    ),
    agents: yield* loadEach(configNames.agent, (agentName) =>
      loadAgent(configDirectory, agentName),
    ),
    settings: yield* loadEach(
      configNames.settings,
      loadDecoded(configDirectory, 'settings', JSON, ClaudeSettings),
    ),
    skills: yield* loadEach(configNames.skill, (skillName) =>
      loadSkill(configDirectory, skillName),
    ),
    tasks: taskFiles,
    homeSets: yield* loadEach(configNames.home, (homeName) =>
      loadHomeSet(configDirectory, homeName),
    ),
    claudeMd: yield* loadEach(configNames.claude_md, (claudeMdName) =>
      readConfigText(configDirectory, configFilePathOf('claude_md', claudeMdName)),
    ),
  }

  const recipes = yield* Effect.all(
    Record.map(config.recipes, (recipe, recipeName) => resolveRecipe(config, recipeName, recipe)),
  )

  return { ...config, names: configNames, recipes }
})
