import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import { configFilePathOf, listConfigNames, loadConfig, type TomlKind } from '../ConfigRepo.ts'
import { renderSchemaFiles } from './Sync.ts'

const LINE_BREAK_PATTERN = /\r?\n/u

export class SchemaLineMissing extends Schema.TaggedError<SchemaLineMissing>()(
  'SchemaLineMissing',
  {
    filePath: Schema.String,
    schemaLine: Schema.String,
  },
) {
  override get message(): string {
    return `${this.filePath} doesn't start with "${this.schemaLine}", so editors can't check it. Make that its first line.`
  }
}

export class SchemaFileStale extends Schema.TaggedError<SchemaFileStale>()('SchemaFileStale', {
  filePath: Schema.String,
}) {
  override get message(): string {
    return `${this.filePath} is out of date with the config's names. Run pie sync.`
  }
}

export class RecipesMissing extends Schema.TaggedError<RecipesMissing>()('RecipesMissing', {
  configDirectory: Schema.String,
}) {
  override get message(): string {
    return `${this.configDirectory} has no recipes/*.toml, so it isn't a pie config. Run pie check from a config checkout, or pass its path.`
  }
}

const requireSchemaLine = Effect.fn('requireSchemaLine')(function* (
  configDirectory: string,
  tomlKind: TomlKind,
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const schemaLine = `#:schema ../${configFilePathOf.schema(tomlKind)}`
  const text = yield* fileSystem.readFileString(path.join(configDirectory, filePath))
  const [firstLine] = text.split(LINE_BREAK_PATTERN, 1)

  yield* Effect.fail(new SchemaLineMissing({ filePath, schemaLine })).pipe(
    Effect.when(Effect.succeed(firstLine !== schemaLine)),
  )
})

const requireFreshSchemaFile = Effect.fn('requireFreshSchemaFile')(function* (
  configDirectory: string,
  filePath: string,
  syncedText: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absoluteFilePath = path.join(configDirectory, filePath)
  const writtenText = (yield* fileSystem.exists(absoluteFilePath))
    ? yield* fileSystem.readFileString(absoluteFilePath)
    : ''

  yield* Effect.fail(new SchemaFileStale({ filePath })).pipe(
    Effect.when(Effect.succeed(writtenText !== syncedText)),
  )
})

export const check = Command.make(
  'check',
  { configDirectory: Argument.String('dir').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ configDirectory }) {
    const config = yield* loadConfig(configDirectory)

    yield* Effect.fail(new RecipesMissing({ configDirectory })).pipe(
      Effect.when(Effect.succeed(Record.isEmptyRecord(config.recipes))),
    )

    const tomlNames: Record.ReadonlyRecord<TomlKind, readonly string[]> = {
      recipe: Record.keys(config.recipes),
      routine: Record.keys(config.routines),
      environment: Record.keys(config.environments),
      mcp: Record.keys(config.mcpServers),
    }

    yield* Effect.forEach(
      Record.toEntries(tomlNames),
      ([tomlKind, names]) =>
        Effect.forEach(
          names,
          (name) => requireSchemaLine(configDirectory, tomlKind, configFilePathOf[tomlKind](name)),
          { discard: true },
        ),
      { discard: true },
    )
    yield* Effect.forEach(
      Record.toEntries(renderSchemaFiles(yield* listConfigNames(configDirectory))),
      ([filePath, syncedText]) => requireFreshSchemaFile(configDirectory, filePath, syncedText),
      { discard: true },
    )
    yield* Console.log('Config is valid.')
  }),
).pipe(
  Command.withDescription(
    'Validate a config repo checkout: the recipes, their references and the schema files. Defaults to the current directory.',
  ),
)
