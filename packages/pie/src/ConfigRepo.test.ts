import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Duration from 'effect/Duration'
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
  EnvironmentExtendsCycle,
  FrontmatterMissing,
  HomeFileAppendOnly,
  HomePathPieOwned,
  HomePathsOverlap,
  loadConfig,
  RecipeNameNotTaggable,
  RoutineNameNotTaggable,
} from './ConfigRepo.ts'

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
repositories = [
  "jliocsar/pie",
  { repo = "jliocsar/nidus", dir = "nidus" },
  { repo = "hapana-hub/hapana-gcp", integration = "hapana-gh-git" },
]
skills = ["handoff"]
mcp = ["fff"]
home = ["shell", { name = "zsh", mode = "append" }]

[claude]
agents = ["oracle"]
settings = "default"
`

const ROUTINE_TOML = `label = "Triage new issues"
recipe = "personal"
schedule = "*/15 * * * *"
timeout = "25 minutes"
prompt = "Triage issues opened since your last run."
`

const ROUTINE_TIMEOUT_MILLISECONDS = 1_500_000

const AGENT_MARKDOWN = `---
name: Oracle, my Oracle
description: deep codebase questions, read-only
model: opus
---
You are...
`

const VALID_CONFIG_FILES: Record.ReadonlyRecord<string, string> = {
  'environments/personal.toml': ENVIRONMENT_TOML,
  'recipes/personal.toml': RECIPE_TOML,
  'routines/triage.toml': ROUTINE_TOML,
  'mcp/fff.toml': 'command = "fff-mcp"\n',
  'mcp/executor.toml': 'url = "http://executor.int.exe.xyz/mcp"\n',
  'claude/agents/oracle.md': AGENT_MARKDOWN,
  'claude/settings/default.json': '{ "model": "opus" }\n',
  'skills/handoff/SKILL.md': '---\nname: handoff\ndescription: writes a handoff\n---\nWrite...\n',
  'tasks/workspace': '#!/bin/sh\nmkdir -p ~/workspace\n',
  'tasks/work/setup-gcloud': '#!/bin/sh\n',
  'home/shell/.config/starship.toml': 'add_newline = false\n',
  'home/zsh/.zshrc': "alias ll='ls -l'\n",
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
          { repo: 'jliocsar/pie', dir: 'jliocsar/pie', integration: 'github' },
          { repo: 'jliocsar/nidus', dir: 'nidus', integration: 'github' },
          {
            repo: 'hapana-hub/hapana-gcp',
            dir: 'hapana-hub/hapana-gcp',
            integration: 'hapana-gh-git',
          },
        ])
        expect(config.recipes['personal']?.home).toEqual([
          {
            homeName: 'shell',
            mode: 'copy',
            sourcePath: 'home/shell/.config/starship.toml',
            homePath: '.config/starship.toml',
          },
          { homeName: 'zsh', mode: 'append', sourcePath: 'home/zsh/.zshrc', homePath: '.zshrc' },
        ])
        expect(config.mcpServers['fff']).toEqual({ command: 'fff-mcp', args: [] })
        expect(config.agents['oracle']).toEqual({
          name: 'Oracle, my Oracle',
          description: 'deep codebase questions, read-only',
        })
        expect(Record.keys(config.skills)).toEqual(['handoff'])
        expect(config.tasks).toEqual(['work/setup-gcloud', 'workspace'])
        expect(config.routines['triage']).toMatchObject({
          recipe: 'personal',
          schedule: '*/15 * * * *',
          arguments: [],
        })
        expect(Duration.toMillis(config.routines['triage']?.timeout ?? Duration.zero)).toBe(
          ROUTINE_TIMEOUT_MILLISECONDS,
        )
      }),
    ))

  test('defaults the lists a recipe leaves out', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfigFrom({
          ...VALID_CONFIG_FILES,
          'recipes/personal.toml': 'label = "Personal"\nenvironment = "personal"\n',
        })

        expect(config.recipes['personal']).toMatchObject({
          repositories: [],
          skills: [],
          mcp: {},
          home: [],
          claude: { agents: [], settings: {} },
        })
      }),
    ))

  test('an environment extends its parent through the whole chain, child keys winning', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfigFrom({
          ...VALID_CONFIG_FILES,
          'environments/node.toml':
            'extends = "personal"\nlabel = "Node"\n\n[tools]\nnode = "25.0.0"\n\n[env]\nNODE_ENV = "development"\n',
          'environments/web.toml':
            'extends = "node"\nlabel = "Web"\ntasks = ["workspace"]\n\n[tools]\n"github:dmtrKovalenko/fff" = "0.11.0"\n',
        })

        expect(config.environments['node']?.tasks).toEqual(['workspace', 'work/setup-gcloud'])
        expect(config.environments['web']).toEqual({
          label: 'Web',
          tools: { node: { version: '25.0.0' }, 'github:dmtrKovalenko/fff': { version: '0.11.0' } },
          env: { GH_HOST: 'github.int.exe.xyz', NODE_ENV: 'development' },
          tasks: ['workspace'],
        })
      }),
    ))

  test('an environment that extends itself through a chain fails naming the loop', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          loadConfigFrom({
            ...VALID_CONFIG_FILES,
            'environments/personal.toml': `extends = "web"\n${ENVIRONMENT_TOML}`,
            'environments/node.toml': 'extends = "personal"\nlabel = "Node"\n',
            'environments/web.toml': 'extends = "node"\nlabel = "Web"\n',
          }),
        )

        expect(error).toBeInstanceOf(EnvironmentExtendsCycle)
        expect(error.message).toBe(
          'environments/node.toml extends itself through node -> personal -> web -> node. Remove one of those extends.',
        )
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
      description: 'a recipe home typo',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('"shell"', '"shel"') },
      message: 'recipes/personal.toml lists home "shel", but home/shel doesn\'t exist.',
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
    {
      description: 'a routine recipe typo',
      overrides: {
        'routines/triage.toml': ROUTINE_TOML.replace('"personal"', '"persona"'),
      },
      message:
        'routines/triage.toml lists recipe "persona", but recipes/persona.toml doesn\'t exist.',
    },
    {
      description: 'an environment extends typo',
      overrides: {
        'environments/node.toml': 'extends = "persona"\nlabel = "Node"\n',
      },
      message:
        'environments/node.toml lists environment "persona", but environments/persona.toml doesn\'t exist.',
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
      description: 'a skill named apart from its directory',
      overrides: {
        'skills/handoff/SKILL.md': '---\nname: sage\ndescription: writes a handoff\n---\n',
      },
      errorClass: ConfigNameMismatch,
      filePath: 'skills/handoff/SKILL.md',
    },
    {
      description: 'an agent with an empty name',
      overrides: {
        'claude/agents/oracle.md': AGENT_MARKDOWN.replace('name: Oracle, my Oracle', 'name: ""'),
      },
      errorClass: ConfigFileInvalid,
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
      description: 'a routine name no exe.dev tag can hold',
      overrides: { 'routines/Triage.toml': ROUTINE_TOML },
      errorClass: RoutineNameNotTaggable,
      filePath: 'routines/Triage.toml',
    },
    ...[
      [
        'a schedule with a seconds field',
        'schedule = "*/15 * * * *"',
        'schedule = "0 */15 * * * *"',
      ],
      ['a schedule that is not cron', 'schedule = "*/15 * * * *"', 'schedule = "every hour"'],
      ['a timeout in short form', 'timeout = "25 minutes"', 'timeout = "25m"'],
      ['a timeout that is not a duration', 'timeout = "25 minutes"', 'timeout = "soon"'],
      ['a zero timeout', 'timeout = "25 minutes"', 'timeout = "0 minutes"'],
      ['a negative timeout', 'timeout = "25 minutes"', 'timeout = "-5 minutes"'],
      ['an infinite timeout', 'timeout = "25 minutes"', 'timeout = "Infinity"'],
    ].map(([description = '', validLine = '', invalidLine = '']) => ({
      description,
      overrides: { 'routines/triage.toml': ROUTINE_TOML.replace(validLine, invalidLine) },
      errorClass: ConfigFileInvalid,
      filePath: 'routines/triage.toml',
    })),
    {
      description: 'a skill without frontmatter',
      overrides: { 'skills/handoff/SKILL.md': 'Write...\n' },
      errorClass: FrontmatterMissing,
      filePath: 'skills/handoff/SKILL.md',
    },
    {
      description: 'a home set shipping a path pie writes itself',
      overrides: { 'home/shell/.claude/settings.json': '{}\n' },
      errorClass: HomePathPieOwned,
      filePath: 'home/shell/.claude/settings.json',
    },
    {
      description: 'a .zshrc copied instead of appended',
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace('{ name = "zsh", mode = "append" }', '"zsh"'),
      },
      errorClass: HomeFileAppendOnly,
      filePath: 'recipes/personal.toml',
    },
    {
      description: 'a copied home file another set also writes',
      overrides: { 'home/zsh/.config/starship.toml': 'format = "$all"\n' },
      errorClass: HomePathsOverlap,
      filePath: 'recipes/personal.toml',
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
