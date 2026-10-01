import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import {
  ConfigFileInvalid,
  ConfigFileUnparseable,
  ConfigNameMismatch,
  ConfigReferenceMissing,
  FrontmatterMissing,
  loadConfig,
  RecipeNameNotTaggable,
} from './Config.ts'

const ENVIRONMENT_TOML = `label = "Personal"
tasks = ["workspace", "work/setup-gcloud"]

[tools]
node = "24.19.0"
"github:dmtrKovalenko/fff" = { version = "0.10.6", matching = "fff-mcp", bin = "fff-mcp" }

[env]
GH_HOST = "github.int.exe.xyz"
`

const RECIPE_TOML = `label = "Personal"
environment = "personal"
repositories = ["jliocsar/pie", { repo = "jliocsar/nidus", dir = "nidus" }]
skills = ["handoff"]
mcp = ["fff"]

[claude]
agents = ["oracle"]
settings = "default"
`

const AGENT_MARKDOWN = `---
name: oracle
description: deep codebase questions, read-only
model: opus
---
You are...
`

const VALID_CONFIG_FILES: Record.ReadonlyRecord<string, string> = {
  'environments/personal.toml': ENVIRONMENT_TOML,
  'recipes/personal.toml': RECIPE_TOML,
  'mcp/fff.toml': 'command = "fff-mcp"\n',
  'mcp/executor.toml': 'url = "http://executor.int.exe.xyz/mcp"\n',
  'claude/agents/oracle.md': AGENT_MARKDOWN,
  'claude/settings/default.json': '{ "model": "opus" }\n',
  'skills/handoff/SKILL.md': '---\nname: handoff\ndescription: writes a handoff\n---\nWrite...\n',
  'tasks/workspace': '#!/bin/sh\nmkdir -p ~/workspace\n',
  'tasks/work/setup-gcloud': '#!/bin/sh\n',
}

const bunServicesRuntime = ManagedRuntime.make(BunServices.layer)

const loadConfigFrom = (configFiles: Record.ReadonlyRecord<string, string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const configDirectory = yield* fileSystem.makeTempDirectoryScoped()

    yield* Effect.forEach(
      Record.toEntries(configFiles),
      ([filePath, content]) =>
        fileSystem
          .makeDirectory(path.dirname(path.join(configDirectory, filePath)), { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(configDirectory, filePath), content),
            ),
          ),
      { discard: true },
    )

    return yield* loadConfig(configDirectory)
  }).pipe(Effect.scoped)

afterAll(() => bunServicesRuntime.dispose())

describe('loadConfig', () => {
  test('reads a config checkout into one typed config', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfigFrom(VALID_CONFIG_FILES)

        expect(config.environments['personal']?.env).toEqual({ GH_HOST: 'github.int.exe.xyz' })
        expect(config.settings).toEqual({ default: { model: 'opus' } })
        expect(config.environments['personal']?.tools).toEqual({
          node: { version: '24.19.0' },
          'github:dmtrKovalenko/fff': { version: '0.10.6', matching: 'fff-mcp', bin: 'fff-mcp' },
        })
        expect(config.recipes['personal']?.repositories).toEqual([
          { repo: 'jliocsar/pie', dir: 'jliocsar/pie' },
          { repo: 'jliocsar/nidus', dir: 'nidus' },
        ])
        expect(config.mcpServers['fff']).toEqual({ command: 'fff-mcp', args: [] })
        expect(config.agents['oracle']).toEqual({
          name: 'oracle',
          description: 'deep codebase questions, read-only',
        })
        expect(Record.keys(config.skills)).toEqual(['handoff'])
        expect(config.tasks).toEqual(['work/setup-gcloud', 'workspace'])
      }),
    ))

  test('defaults the lists a recipe leaves out', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfigFrom({
          ...VALID_CONFIG_FILES,
          'recipes/personal.toml': 'label = "Personal"\nenvironment = "personal"\n',
        })

        expect(config.recipes['personal']).toEqual({
          label: 'Personal',
          environment: 'personal',
          repositories: [],
          skills: [],
          mcp: [],
          claude: { agents: [] },
        })
      }),
    ))

  test.each([
    {
      description: 'a recipe agent typo',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('"oracle"', '"oracel"') },
      message:
        'recipes/personal.toml lists agent "oracel", but claude/agents/oracel.md doesn\'t exist.',
    },
    {
      description: 'a recipe settings typo',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('"default"', '"defualt"') },
      message:
        'recipes/personal.toml lists settings "defualt", but claude/settings/defualt.json doesn\'t exist.',
    },
    {
      description: 'a recipe skill typo',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('"handoff"', '"handof"') },
      message:
        'recipes/personal.toml lists skill "handof", but skills/handof/SKILL.md doesn\'t exist.',
    },
    {
      description: 'a recipe mcp typo',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('"fff"', '"ff"') },
      message: 'recipes/personal.toml lists mcp "ff", but mcp/ff.toml doesn\'t exist.',
    },
    {
      description: 'a recipe environment typo',
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace('"personal"', '"persona"'),
      },
      message:
        'recipes/personal.toml lists environment "persona", but environments/persona.toml doesn\'t exist.',
    },
    {
      description: 'an environment task typo',
      overrides: {
        'environments/personal.toml': ENVIRONMENT_TOML.replace('"workspace"', '"workspac"'),
      },
      message:
        'environments/personal.toml lists task "workspac", but tasks/workspac doesn\'t exist.',
    },
  ])('$description fails naming the file and the missing name', ({ overrides, message }) =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadConfigFrom({ ...VALID_CONFIG_FILES, ...overrides }))

        expect(error).toBeInstanceOf(ConfigReferenceMissing)
        expect(error.message).toBe(message)
      }),
    ),
  )

  test.each([
    {
      description: 'an agent named apart from its file',
      overrides: {
        'claude/agents/oracle.md': AGENT_MARKDOWN.replace('name: oracle', 'name: sage'),
      },
      errorClass: ConfigNameMismatch,
      filePath: 'claude/agents/oracle.md',
    },
    {
      description: 'settings that are not a JSON object',
      overrides: { 'claude/settings/default.json': '["opus"]\n' },
      errorClass: ConfigFileInvalid,
      filePath: 'claude/settings/default.json',
    },
    {
      description: 'an unknown recipe key',
      overrides: { 'recipes/personal.toml': `${RECIPE_TOML}agnets = ["oracle"]\n` },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
    },
    {
      description: 'a task list under [env]',
      overrides: { 'environments/personal.toml': `${ENVIRONMENT_TOML}tasks = ["workspace"]\n` },
      errorClass: ConfigFileInvalid,
      filePath: 'environments/personal.toml',
    },
    {
      description: 'a tool table without a version',
      overrides: {
        'environments/personal.toml': ENVIRONMENT_TOML.replace('version = "0.10.6", ', ''),
      },
      errorClass: ConfigFileInvalid,
      filePath: 'environments/personal.toml',
    },
    {
      description: 'broken TOML',
      overrides: { 'mcp/fff.toml': 'command =\n' },
      errorClass: ConfigFileUnparseable,
      filePath: 'mcp/fff.toml',
    },
    {
      description: 'a recipe name no exe.dev tag can hold',
      overrides: { 'recipes/Work.toml': RECIPE_TOML },
      errorClass: RecipeNameNotTaggable,
      filePath: 'recipes/Work.toml',
    },
    {
      description: 'a skill without frontmatter',
      overrides: { 'skills/handoff/SKILL.md': 'Write...\n' },
      errorClass: FrontmatterMissing,
      filePath: 'skills/handoff/SKILL.md',
    },
  ])('$description fails naming the file', ({ overrides, errorClass, filePath }) =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadConfigFrom({ ...VALID_CONFIG_FILES, ...overrides }))

        expect(error).toBeInstanceOf(errorClass)
        expect(error.message).toStartWith(filePath)
      }),
    ),
  )
})
