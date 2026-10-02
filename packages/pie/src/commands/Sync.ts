import * as Arr from 'effect/Array'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as JsonSchema from 'effect/JsonSchema'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import {
  configFilePathOf,
  type ConfigNames,
  listConfigNames,
  ReferenceKind,
  SCHEMA_DIRECTORY,
  tomlSchemas,
} from '../ConfigRepo.ts'

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
        [configFilePathOf.schema(tomlKind), renderJsonSchema(schema, configNames)] as const,
    ),
  )

export const sync = Command.make(
  'sync',
  { configDirectory: Argument.String('dir').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ configDirectory }) {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const schemaFiles = renderSchemaFiles(yield* listConfigNames(configDirectory))

    yield* fileSystem.makeDirectory(path.join(configDirectory, SCHEMA_DIRECTORY), {
      recursive: true,
    })
    yield* Effect.forEach(
      Record.toEntries(schemaFiles),
      ([schemaFilePath, schemaText]) =>
        fileSystem.writeFileString(path.join(configDirectory, schemaFilePath), schemaText),
      { discard: true },
    )
    yield* Console.log(`Synced ${path.join(configDirectory, SCHEMA_DIRECTORY)}.`)
  }),
).pipe(
  Command.withDescription(
    'Rewrite .pie/schema from the names on disk, so editors autocomplete them. Run it after adding or renaming a config file.',
  ),
)
