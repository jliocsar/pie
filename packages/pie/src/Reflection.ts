import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'

export const REFLECTION_TAGS_URL = 'https://reflection.int.exe.xyz/tags'

export const RECIPE_TAG_PREFIX = 'pie-recipe-'

const VmTags = Schema.Struct({ tags: Schema.Array(Schema.String) })

const listOf = (names: readonly string[]) =>
  Arr.isReadonlyArrayNonEmpty(names) ? names.join(', ') : 'none'

export class ReflectionUnreadable extends Schema.TaggedError<ReflectionUnreadable>()(
  'ReflectionUnreadable',
  { failureMessage: Schema.String },
) {
  override get message(): string {
    return `pie reads this VM's tags from ${REFLECTION_TAGS_URL}, and that failed: ${this.failureMessage}. pie pod up runs on exe.dev VMs with the reflection integration attached.`
  }
}

export class RecipeTagMissing extends Schema.TaggedError<RecipeTagMissing>()('RecipeTagMissing', {
  vmTags: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `This VM has no ${RECIPE_TAG_PREFIX}<recipe> tag, so pie doesn't know its recipe. Its tags: ${listOf(this.vmTags)}. Add one with \`ssh exe.dev tag <vm> ${RECIPE_TAG_PREFIX}<recipe>\`.`
  }
}

export class RecipeTagsConflict extends Schema.TaggedError<RecipeTagsConflict>()(
  'RecipeTagsConflict',
  { recipeTags: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This VM has more than one recipe tag: ${listOf(this.recipeTags)}. Keep one, removing the others with \`ssh exe.dev tag -d <vm> <tag>\`.`
  }
}

export const recipeNameOfThisVm = Effect.gen(function* () {
  const httpClient = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const { tags } = yield* httpClient.get(REFLECTION_TAGS_URL).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(VmTags)),
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(new ReflectionUnreadable({ failureMessage: error.message })),
      SchemaError: (error) =>
        Effect.fail(new ReflectionUnreadable({ failureMessage: error.message })),
    }),
  )
  const recipeTags = Arr.filter(tags, (tag) => tag.startsWith(RECIPE_TAG_PREFIX))

  return yield* Arr.match(recipeTags, {
    onEmpty: () => Effect.fail(new RecipeTagMissing({ vmTags: tags })),
    onNonEmpty: ([recipeTag, ...otherRecipeTags]) =>
      Arr.isReadonlyArrayNonEmpty(otherRecipeTags)
        ? Effect.fail(new RecipeTagsConflict({ recipeTags }))
        : Effect.succeed(recipeTag.slice(RECIPE_TAG_PREFIX.length)),
  })
})
