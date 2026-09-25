import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const Names = Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

export const Environment = Schema.Struct({
  label: Schema.String,
  tools: Schema.Record(Schema.String, Schema.String),
  tasks: Names,
})

export type Environment = typeof Environment.Type

export const RepositoryName = Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/u))

export const Repository = Schema.Union([
  RepositoryName,
  Schema.Struct({ repo: RepositoryName, dir: Schema.String }),
])

export type Repository = typeof Repository.Type

export const Recipe = Schema.Struct({
  label: Schema.String,
  environment: Schema.String,
  repositories: Schema.Array(Repository).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  agents: Names,
  skills: Names,
  mcp: Names,
})

export type Recipe = typeof Recipe.Type

export const HttpMcpServer = Schema.Struct({
  url: Schema.String,
  auth: Schema.optionalKey(Schema.String),
})

export const StdioMcpServer = Schema.Struct({
  command: Schema.String,
  args: Names,
})

export const McpServer = Schema.Union([HttpMcpServer, StdioMcpServer])

export type McpServer = typeof McpServer.Type

export const Frontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})

export type Frontmatter = typeof Frontmatter.Type

export const Config = Schema.Struct({
  environments: Schema.Record(Schema.String, Environment),
  recipes: Schema.Record(Schema.String, Recipe),
  mcpServers: Schema.Record(Schema.String, McpServer),
  agents: Schema.Record(Schema.String, Frontmatter),
  skills: Schema.Record(Schema.String, Frontmatter),
  tasks: Schema.Array(Schema.String),
})

export type Config = typeof Config.Type
