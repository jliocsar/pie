import * as Arr from 'effect/Array'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { pipe } from 'effect/Function'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'

const TAG_PATTERN = /^[a-z0-9_-]+$/u
const INTEGRATION_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u
const DEFAULT_INTEGRATION_URL = 'https://{integration}.int.exe.xyz'
const INTEGRATION_PLACEHOLDER = '{integration}'

export const REFLECTION_INDEX_URL = 'https://reflection.int.exe.xyz/'
export const REFLECTION_TAGS_URL = 'https://reflection.int.exe.xyz/tags'
export const POD_TAG = 'pie'
export const RECIPE_TAG_PREFIX = 'pie-recipe-'

const VmIndex = Schema.Struct({ name: Schema.String })
const VmTags = Schema.Struct({ tags: Schema.Array(Schema.String) })

export const TagName = Schema.String.check(
  Schema.isPattern(TAG_PATTERN, { message: 'An exe.dev tag uses only a-z, 0-9, _ and -.' }),
)

export const RecipeName = TagName.pipe(Schema.brand('RecipeName'))

export type RecipeName = typeof RecipeName.Type

export const IntegrationName = Schema.String.check(
  Schema.isPattern(INTEGRATION_PATTERN, {
    message:
      'An integration name becomes the host <integration>.int.exe.xyz, so it uses only a-z, 0-9 and -, and starts and ends with a letter or digit.',
  }),
).pipe(Schema.brand('IntegrationName'))

export type IntegrationName = typeof IntegrationName.Type

export const GITHUB_INTEGRATION = IntegrationName.make('github')

export const integrationUrlOf = (integrationName: IntegrationName) =>
  Config.String('PIE_INTEGRATION_URL').pipe(
    Config.withDefault(DEFAULT_INTEGRATION_URL),
    Config.map((integrationUrl) =>
      integrationUrl.replaceAll(INTEGRATION_PLACEHOLDER, integrationName),
    ),
  )

export const RequiredTagName = TagName.check(
  Schema.makeFilter(
    (tagName: string) => tagName !== POD_TAG && !tagName.startsWith(RECIPE_TAG_PREFIX),
    {
      message: `Every pie VM already carries ${POD_TAG} and one ${RECIPE_TAG_PREFIX}<recipe> tag, so a recipe's tags list neither: another recipe's tag would give its VMs two recipes.`,
    },
  ),
)

export const isRecipeName = Schema.is(RecipeName)

const listOf = (names: readonly string[]) =>
  Arr.isReadonlyArrayNonEmpty(names) ? names.join(', ') : 'none'

export class ReflectionUnreadable extends Schema.TaggedError<ReflectionUnreadable>()(
  'ReflectionUnreadable',
  { reflectionUrl: Schema.String, failureMessage: Schema.String },
) {
  override get message(): string {
    return `pie reads this VM's details from ${this.reflectionUrl}, and that failed: ${this.failureMessage}. pie pod up runs on exe.dev VMs with the reflection integration attached.`
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

export class VmTagsMissing extends Schema.TaggedError<VmTagsMissing>()('VmTagsMissing', {
  vmName: Schema.String,
  recipeName: Schema.String,
  missingTags: Schema.NonEmptyArray(Schema.String),
}) {
  override get message(): string {
    return `Recipe ${this.recipeName} needs this VM to carry ${this.missingTags.join(', ')}, and it doesn't. pie can't tag a VM, so add them from the laptop with \`ssh exe.dev tag ${this.vmName} ${this.missingTags.join(' ')}\`, then run pie pod up again.`
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

const readReflection = Effect.fn('readReflection')(function* <Decoded>(
  reflectionUrl: string,
  schema: Schema.Codec<Decoded, unknown>,
) {
  const httpClient = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

  return yield* httpClient.get(reflectionUrl).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(new ReflectionUnreadable({ reflectionUrl, failureMessage: error.message })),
      SchemaError: (error) =>
        Effect.fail(new ReflectionUnreadable({ reflectionUrl, failureMessage: error.message })),
    }),
  )
})

export const tagsOfThisVm = readReflection(REFLECTION_TAGS_URL, VmTags).pipe(
  Effect.map(({ tags }) => tags),
)

const nameOfThisVm = readReflection(REFLECTION_INDEX_URL, VmIndex).pipe(
  Effect.map(({ name }) => name),
)

export const recipeNameOf = Effect.fn('recipeNameOf')(function* (vmTags: readonly string[]) {
  const recipeTags = Arr.filter(vmTags, (tag) => tag.startsWith(RECIPE_TAG_PREFIX))

  return yield* Arr.match(recipeTags, {
    onEmpty: () => Effect.fail(new RecipeTagMissing({ vmTags })),
    onNonEmpty: ([recipeTag, ...otherRecipeTags]) =>
      Arr.isReadonlyArrayNonEmpty(otherRecipeTags)
        ? Effect.fail(new RecipeTagsConflict({ recipeTags }))
        : Option.match(Schema.decodeOption(RecipeName)(recipeTag.slice(RECIPE_TAG_PREFIX.length)), {
            onNone: () => Effect.fail(new RecipeTagMissing({ vmTags })),
            onSome: Effect.succeed,
          }),
  })
})

export const requireRecipeTags = Effect.fn('requireRecipeTags')(function* (
  recipeName: RecipeName,
  recipeTags: readonly string[],
  vmTags: readonly string[],
) {
  yield* pipe(
    recipeTags,
    Arr.difference(vmTags),
    Arr.match({
      onEmpty: () => Effect.void,
      onNonEmpty: (missingTags) =>
        Effect.flatMap(nameOfThisVm, (vmName) =>
          Effect.fail(new VmTagsMissing({ vmName, recipeName, missingTags })),
        ),
    }),
  )
})
