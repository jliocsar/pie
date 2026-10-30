import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import {
  configFilePathOf,
  loadConfig,
  renderSchemaFiles,
  schemaFilePathOf,
  tomlSchemas,
  type TomlKind,
} from '../ConfigRepo.ts'

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
    return `${this.configDirectory} has no ${configFilePathOf('recipe', '*')}, so it isn't a pie config. Run pie check from a config checkout, or pass its path.`
  }
}

const requireSchemaLine = Effect.fn('requireSchemaLine')(function* (
  configDirectory: string,
  tomlKind: TomlKind,
  name: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filePath = configFilePathOf(tomlKind, name)
  const schemaLine = `#:schema ${path.relative(path.dirname(filePath), schemaFilePathOf(tomlKind))}`
  const text = yield* fileSystem.readFileString(path.join(configDirectory, filePath))
  const [firstLine] = text.split(LINE_BREAK_PATTERN, 1)

  if (firstLine !== schemaLine) {
    return yield* new SchemaLineMissing({ filePath, schemaLine })
  }

  return text
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

  if (writtenText !== syncedText) {
    return yield* new SchemaFileStale({ filePath })
  }

  return writtenText
})

export const check = Command.make(
  'check',
  { configDirectory: Argument.String('dir').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ configDirectory }) {
    const config = yield* loadConfig(configDirectory)

    if (Record.isEmptyRecord(config.recipes)) {
      return yield* new RecipesMissing({ configDirectory })
    }

    yield* Effect.forEach(
      Record.keys(tomlSchemas),
      (tomlKind) =>
        Effect.forEach(
          config.names[tomlKind],
          (name) => requireSchemaLine(configDirectory, tomlKind, name),
          { discard: true },
        ),
      { discard: true },
    )
    yield* Effect.forEach(
      Record.toEntries(renderSchemaFiles(config.names)),
      ([filePath, syncedText]) => requireFreshSchemaFile(configDirectory, filePath, syncedText),
      { discard: true },
    )

    return yield* Console.log('Config is valid.')
  }),
).pipe(
  Command.withDescription(
    'Validate a config repo checkout: the recipes, their references and the schema files. Defaults to the current directory.',
  ),
)
