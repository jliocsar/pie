import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import { ConfigRepo } from '../ConfigRepo.ts'
import { EditorSchemas } from '../EditorSchemas.ts'

export const sync = Command.make(
  'sync',
  { configDirectory: Argument.String('dir').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ configDirectory }) {
    const configRepo = yield* ConfigRepo
    const editorSchemas = yield* EditorSchemas
    const schemaDirectory = yield* editorSchemas.write(
      configDirectory,
      yield* configRepo.listNames(configDirectory),
    )

    yield* Console.log(`Synced ${schemaDirectory}.`)
  }),
).pipe(
  Command.provide(Layer.mergeAll(ConfigRepo.layer, EditorSchemas.layer)),
  Command.withDescription(
    'Rewrite .pie/schema from the names on disk, so editors autocomplete them. Run it after adding or renaming a config file.',
  ),
)
