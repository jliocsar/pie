import * as Arr from 'effect/Array'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as JsonSchema from 'effect/JsonSchema'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import {
  type ConfigNames,
  configFilePathOf,
  ReferenceKind,
  type TomlKind,
  tomlSchemas,
} from './ConfigRepo.ts'

const LINE_BREAK_PATTERN = /\r?\n/u
const SCHEMA_DIRECTORY = '.pie/schema'

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
    return `${this.filePath} isn't what pie sync writes now, because a config name changed or pie did. Run pie sync and commit the result.`
  }
}

const schemaFilePathOf = (tomlKind: TomlKind) => `${SCHEMA_DIRECTORY}/${tomlKind}.json`

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

const renderSchemaFiles = (configNames: ConfigNames) =>
  Arr.map(
    Record.toEntries(tomlSchemas),
    ([tomlKind, schema]) =>
      [schemaFilePathOf(tomlKind), renderJsonSchema(schema, configNames)] as const,
  )

export class EditorSchemas extends Context.Service<EditorSchemas>()('pie/EditorSchemas', {
  make: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const write = Effect.fn('EditorSchemas.write')(function* (
      configDirectory: string,
      configNames: ConfigNames,
    ) {
      const schemaDirectory = path.join(configDirectory, SCHEMA_DIRECTORY)

      yield* fileSystem.makeDirectory(schemaDirectory, { recursive: true })
      yield* Effect.forEach(
        renderSchemaFiles(configNames),
        ([schemaFilePath, schemaText]) =>
          fileSystem.writeFileString(path.join(configDirectory, schemaFilePath), schemaText),
        { discard: true },
      )

      return schemaDirectory
    })

    const requireSchemaLine = Effect.fn('EditorSchemas.requireSchemaLine')(function* (
      configDirectory: string,
      tomlKind: TomlKind,
      name: string,
    ) {
      const filePath = configFilePathOf(tomlKind, name)
      const schemaLine = `#:schema ${path.relative(path.dirname(filePath), schemaFilePathOf(tomlKind))}`

      yield* fileSystem.readFileString(path.join(configDirectory, filePath)).pipe(
        Effect.filterOrFail(
          (text) => text.split(LINE_BREAK_PATTERN, 1)[0] === schemaLine,
          () => new SchemaLineMissing({ filePath, schemaLine }),
        ),
      )
    })

    const requireFreshSchemaFile = Effect.fn('EditorSchemas.requireFreshSchemaFile')(function* (
      configDirectory: string,
      filePath: string,
      syncedText: string,
    ) {
      const absoluteFilePath = path.join(configDirectory, filePath)

      yield* fileSystem.exists(absoluteFilePath).pipe(
        Effect.flatMap((fileExists) =>
          fileExists ? fileSystem.readFileString(absoluteFilePath) : Effect.succeed(''),
        ),
        Effect.filterOrFail(
          (writtenText) => writtenText === syncedText,
          () => new SchemaFileStale({ filePath }),
        ),
      )
    })

    const check = Effect.fn('EditorSchemas.check')(function* (
      configDirectory: string,
      configNames: ConfigNames,
    ) {
      yield* Effect.forEach(
        Record.keys(tomlSchemas),
        (tomlKind) =>
          Effect.forEach(
            configNames[tomlKind],
            (name) => requireSchemaLine(configDirectory, tomlKind, name),
            { discard: true },
          ),
        { discard: true },
      )
      yield* Effect.forEach(
        renderSchemaFiles(configNames),
        ([filePath, syncedText]) => requireFreshSchemaFile(configDirectory, filePath, syncedText),
        { discard: true },
      )
    })

    return { write, check }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
