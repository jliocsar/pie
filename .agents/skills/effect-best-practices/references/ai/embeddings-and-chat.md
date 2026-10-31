# Embeddings, Chat & AiError

## Embeddings

Core: `EmbeddingModel.EmbeddingModel` service with `embed(input: string)` → `EmbedResponse { vector }` and `embedMany(inputs: string[])` → `EmbedManyResponse { embeddings, usage }`. Also `EmbeddingModel.Dimensions` service (number).

```ts
import * as EmbeddingModel from "effect/unstable/ai/EmbeddingModel"
import { OpenAiEmbeddingModel } from "@effect/ai-openai"
import * as Effect from "effect/Effect"

const embedLayer = OpenAiEmbeddingModel.model("text-embedding-3-small", {
  dimensions: 1536
})  // Model<"openai", EmbeddingModel | Dimensions, OpenAiClient>

const program = Effect.gen(function*() {
  const model = yield* EmbeddingModel.EmbeddingModel
  const one = yield* model.embed("hello")          // one.vector: number[]
  const many = yield* model.embedMany(["a", "b"])  // many.embeddings[i].vector
}).pipe(Effect.provide(embedLayer))
```

- `embed` is internally batched through a `RequestResolver` so concurrent `embed` calls coalesce into one provider `embedMany`.
- `embedMany([])` returns empty WITHOUT calling the provider.
- Provider must return exactly one vector per input in order, else `AiError.InvalidOutputError`.
- `OpenAiEmbeddingModel.layer`/`make` exist when you don't need the `Dimensions` service.

## Chat — stateful sessions

Constructors: `Chat.empty: Effect<Chat>`, `Chat.fromPrompt(prompt: Prompt.RawInput): Effect<Chat>`, `Chat.fromJson(json: string): Effect<Chat, SchemaError>`, `Chat.fromExport(data: unknown): Effect<Chat, SchemaError>`, `Chat.makePersisted({...})`.

History is kept in `session.history: Ref<Prompt.Prompt>`. Each turn appends automatically.

```ts
import * as Chat from "effect/unstable/ai/Chat"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

const session = yield* Chat.fromPrompt(
  Prompt.empty.pipe(Prompt.setSystem("You are a helpful assistant."))
)

const response = yield* session.generateText({ prompt: message }).pipe(Effect.provide(modelLayer))

const history = yield* Ref.get(session.history)
const json = yield* session.exportJson   // Effect<string, AiError>
const restored = yield* Chat.fromJson(json)
```

`Chat.fromPrompt` accepts a messages array:

```ts
yield* Chat.fromPrompt([
  { role: "system", content: "You are an assistant that can use tools." },
  { role: "user", content: question }
])
```

Chat also exposes `generateObject` and `streamText` (same option shapes as LanguageModel).

### Agentic loop (tools + chat)

```ts
const tools = yield* Tools
while (true) {
  const response = yield* session.generateText({
    prompt: [],       // empty — model has full history
    toolkit: tools
  }).pipe(Effect.provide(modelLayer))
  if (response.toolCalls.length > 0) continue  // results auto-added to history
  return response.text
}
```

- DO loop while `response.toolCalls.length > 0`; let Chat manage history.

## AiError handling

`AiError` is a `Schema.Error` with `_tag: "AiError"`, `module`, `method`, and a `reason: AiErrorReason`. `error.isRetryable` and `error.retryAfter` delegate to the reason.

`AiErrorReason` union (18 members): `RateLimitError, QuotaExhaustedError, AuthenticationError, ContentPolicyError, InvalidRequestError, InternalProviderError, NetworkError, InvalidOutputError, StructuredOutputError, UnsupportedSchemaError, UnknownError, ToolNotFoundError, ToolParameterValidationError, InvalidToolResultError, ToolResultEncodingError, ToolConfigurationError, ToolkitRequiredError, InvalidUserInputError`. Each carries `_tag`, `message`, `isRetryable`.

- DO map `AiError` → domain error with `Schema.TaggedError` embedding `AiError.AiErrorReason` (itself a Schema).

```ts
export class AiWriterError extends Schema.TaggedError<AiWriterError>()("AiWriterError", {
  reason: AiError.AiErrorReason
}) {
  static fromAiError(error: AiError.AiError) {
    return new AiWriterError({ reason: error.reason })
  }
}

.pipe(Effect.mapError((error) => AiWriterError.fromAiError(error)))
```

- DO catch by tag and DIE on unexpected defects.

```ts
Effect.catchTag(
  "AiError",
  (error) => Effect.fail(new AiAssistantError({ reason: error.reason })),
  (e) => Effect.die(e)
)
```

- Branch on the reason with `Effect.catchReason("AiError", "RateLimitError", …)` / `Effect.catchReasons`, or `Match.value(error.reason).pipe(Match.tagsExhaustive({…}))`; use `error.retryAfter` / `error.isRetryable`. Never read `error.reason._tag` — `_` means private.
- Guards: `AiError.isAiError`, `AiError.isAiErrorReason`. `Effect.catchReason` is supported for reason-based handling.
