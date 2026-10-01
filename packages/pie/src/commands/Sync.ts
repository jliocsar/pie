import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import { listConfigNames, renderSchemaFiles, SCHEMA_DIRECTORY } from '../Config.ts'

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
)
