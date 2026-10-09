import * as Arr from 'effect/Array'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { pipe } from 'effect/Function'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'

const TAG_PATTERN = /^[a-z0-9_-]+$/u
const DEFAULT_INTEGRATION_URL = 'https://{integration}.int.exe.xyz'
const INTEGRATION_PLACEHOLDER = '{integration}'

export const GITHUB_INTEGRATION = 'github'
export const REFLECTION_TAGS_URL = 'https://reflection.int.exe.xyz/tags'
export const POD_TAG = 'pie'
export const RECIPE_TAG_PREFIX = 'pie-recipe-'
export const ROUTINE_TAG_PREFIX = 'pie-routine-'

const VmTags = Schema.Struct({ tags: Schema.Array(Schema.String) })

export const integrationUrlOf = (integrationName: string) =>
  Config.String('PIE_INTEGRATION_URL').pipe(
    Config.withDefault(DEFAULT_INTEGRATION_URL),
    Config.map((integrationUrl) =>
      integrationUrl.replaceAll(INTEGRATION_PLACEHOLDER, integrationName),
    ),
  )

export const isValidTag = (tag: string) => TAG_PATTERN.test(tag)

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

export class RepositoryUnreachable extends Schema.TaggedError<RepositoryUnreachable>()(
  'RepositoryUnreachable',
  {
    repositoryName: Schema.String,
    integrationName: Schema.String,
    integrationTag: Schema.String,
    gitOutput: Schema.String,
  },
) {
  override get message(): string {
    const fix =
      this.integrationName === GITHUB_INTEGRATION
        ? `In exe.dev, attach a GitHub integration that reaches it to tag:${this.integrationTag}.`
        : `In exe.dev, check that the ${this.integrationName} integration is attached to tag:${this.integrationTag} and that its token can read the repository.`

    return `pie couldn't reach ${this.repositoryName} through exe.dev's ${this.integrationName} integration. ${fix} git said: ${this.gitOutput.trim()}`
  }
}

export const podTagsOfThisVm = Effect.gen(function* () {
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
  const recipeName = yield* Arr.match(recipeTags, {
    onEmpty: () => Effect.fail(new RecipeTagMissing({ vmTags: tags })),
    onNonEmpty: ([recipeTag, ...otherRecipeTags]) =>
      Arr.isReadonlyArrayNonEmpty(otherRecipeTags)
        ? Effect.fail(new RecipeTagsConflict({ recipeTags }))
        : Effect.succeed(recipeTag.slice(RECIPE_TAG_PREFIX.length)),
  })
  const routineNames = pipe(
    tags,
    Arr.filter((tag) => tag.startsWith(ROUTINE_TAG_PREFIX)),
    Arr.map((routineTag) => routineTag.slice(ROUTINE_TAG_PREFIX.length)),
  )

  return { recipeName, routineNames }
})
