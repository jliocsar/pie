import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import { ConfigRepo, configFilePathOf } from '../ConfigRepo.ts'
import { EditorSchemas } from '../EditorSchemas.ts'

class RecipesMissing extends Schema.TaggedError<RecipesMissing>()('RecipesMissing', {
  configDirectory: Schema.String,
}) {
  override get message(): string {
    return `${this.configDirectory} has no ${configFilePathOf('recipe', '*')}, so it isn't a pie config. Run pie check from a config checkout, or pass its path.`
  }
}

export const check = Command.make(
  'check',
  { configDirectory: Argument.String('dir').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ configDirectory }) {
    const configRepo = yield* ConfigRepo
    const editorSchemas = yield* EditorSchemas
    const config = yield* configRepo.load(configDirectory)

    if (Record.isEmptyRecord(config.recipes)) {
      return yield* new RecipesMissing({ configDirectory })
    }

    yield* editorSchemas.check(configDirectory, config.names)

    return yield* Console.log('Config is valid.')
  }),
).pipe(
  Command.provide(Layer.mergeAll(ConfigRepo.layer, EditorSchemas.layer)),
  Command.withDescription(
    'Validate a config repo checkout: the recipes, their references and the schema files. Defaults to the current directory.',
  ),
)
