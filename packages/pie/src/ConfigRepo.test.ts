import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Record from 'effect/Record'
import {
  ConfigFileInvalid,
  ConfigFileUnparseable,
  ConfigNameMismatch,
  ConfigReferenceMissing,
  EnvironmentExtendsCycle,
  ConfigRepo,
  FrontmatterMissing,
  HomeFileAppendOnly,
  HomePathPieOwned,
  HomePathsOverlap,
  RecipeNameNotTaggable,
} from './ConfigRepo.ts'
import { writeConfigFiles } from './test/TestPie.ts'

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
mcp = ["fff", "executor"]
home = ["shell", { name = "zsh", mode = "append" }]

[claude]
agents = ["oracle"]
settings = "default"
claude_md = ["work", "gcp"]
`

const AGENT_MARKDOWN = `---
name: Oracle, my Oracle
description: deep codebase questions, read-only
model: opus
---
You are...
`

const VALID_CONFIG_FILES = {
  'environments/personal.toml': ENVIRONMENT_TOML,
  'recipes/personal.toml': RECIPE_TOML,
  'mcp/fff.toml': 'command = "fff-mcp"\n',
  'mcp/executor.toml': 'url = "http://executor.int.exe.xyz/mcp"\n',
  'claude/agents/oracle.md': AGENT_MARKDOWN,
  'claude/settings/default.json': '{ "model": "opus" }\n',
  'claude/claude_md/work.md': '## Work\n',
  'claude/claude_md/gcp.md': '## GCP\n',
  'skills/handoff/SKILL.md': '---\nname: handoff\ndescription: writes a handoff\n---\nWrite...\n',
  'skills/handoff/scripts/greet': '#!/bin/sh\necho hi\n',
  'tasks/workspace': '#!/bin/sh\nmkdir -p ~/workspace\n',
  'tasks/work/setup-gcloud': '#!/bin/sh\n',
  'home/shell/.config/starship.toml': 'add_newline = false\n',
  'home/zsh/.zshrc': "alias ll='ls -l'\n",
} satisfies Record.ReadonlyRecord<string, string>

const bunServicesRuntime = ManagedRuntime.make(
  ConfigRepo.layer.pipe(Layer.provideMerge(BunServices.layer)),
)

const decodeText = (content: Uint8Array) => new TextDecoder().decode(content)

const loadConfigFrom = (configFiles: Record.ReadonlyRecord<string, string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const configDirectory = yield* fileSystem.makeTempDirectoryScoped()

    yield* writeConfigFiles(configDirectory, configFiles, [])

    const configRepo = yield* ConfigRepo

    return yield* configRepo.load(configDirectory)
  }).pipe(Effect.scoped)

afterAll(() => bunServicesRuntime.dispose())

describe('loadConfig', () => {
  test('reads a config checkout into one typed config', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const config = yield* loadConfigFrom(VALID_CONFIG_FILES)
        const recipe = yield* Effect.fromOption(Record.get(config.recipes, 'personal'))
        const repositories: readonly Record.ReadonlyRecord<string, string>[] = recipe.repositories

        expect(recipe.environment.env).toEqual({ GH_HOST: 'github.int.exe.xyz' })
        expect(recipe.claude.settings).toEqual({ model: 'opus' })
        expect(recipe.environment.tools).toEqual({
          node: { version: '24.19.0' },
          'github:dmtrKovalenko/fff': { version: '0.10.6', matching: 'fff-mcp', bin: 'fff-mcp' },
        })
        expect(repositories).toEqual([
          { repo: 'jliocsar/pie', dir: 'jliocsar/pie', integration: 'github' },
          { repo: 'jliocsar/nidus', dir: 'nidus', integration: 'github' },
          {
            repo: 'hapana-hub/hapana-gcp',
            dir: 'hapana-hub/hapana-gcp',
            integration: 'hapana-gh-git',
          },
        ])
        expect(
          Arr.map(recipe.home, ({ content, ...homeFile }) => ({
            ...homeFile,
            text: decodeText(content),
          })),
        ).toEqual([
          {
            homeName: 'shell',
            mode: 'copy',
            homePath: '.config/starship.toml',
            executable: false,
            text: VALID_CONFIG_FILES['home/shell/.config/starship.toml'],
          },
          {
            homeName: 'zsh',
            mode: 'append',
            homePath: '.zshrc',
            executable: false,
            text: VALID_CONFIG_FILES['home/zsh/.zshrc'],
          },
        ])
        expect(
          Arr.map(recipe.environment.tasks, ({ taskName, content }) => [
            taskName,
            decodeText(content),
          ]),
        ).toEqual([
          ['workspace', VALID_CONFIG_FILES['tasks/workspace']],
          ['work/setup-gcloud', VALID_CONFIG_FILES['tasks/work/setup-gcloud']],
        ])
        expect(
          Arr.map(recipe.claude.files, ({ claudePath, content }) => [
            claudePath,
            decodeText(content),
          ]),
        ).toEqual([
          ['agents/oracle.md', AGENT_MARKDOWN],
          ['skills/handoff/SKILL.md', VALID_CONFIG_FILES['skills/handoff/SKILL.md']],
          ['skills/handoff/scripts/greet', VALID_CONFIG_FILES['skills/handoff/scripts/greet']],
        ])
        expect(recipe.claude.instructionTexts).toEqual(['## Work\n', '## GCP\n'])
        expect(recipe.claude.mcpServers).toEqual({
          executor: { type: 'http', url: 'http://executor.int.exe.xyz/mcp' },
          fff: { type: 'stdio', command: 'fff-mcp', args: [] },
        })
        expect(config.names.skill).toEqual(['handoff'])
        expect(config.names.task).toEqual(['work/setup-gcloud', 'workspace'])
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
          tags: [],
          repositories: [],
          home: [],
          claude: { files: [], settings: {}, mcpServers: {}, instructionTexts: [] },
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
          'recipes/node.toml': 'label = "Node"\nenvironment = "node"\n',
          'recipes/web.toml': 'label = "Web"\nenvironment = "web"\n',
        })
        const taskNamesOf = (recipeName: string) =>
          Arr.map(config.recipes[recipeName]?.environment.tasks ?? [], (task) => task.taskName)

        expect(taskNamesOf('node')).toEqual(['workspace', 'work/setup-gcloud'])
        expect(taskNamesOf('web')).toEqual(['workspace'])
        expect(config.recipes['web']?.environment).toMatchObject({
          tools: { node: { version: '25.0.0' }, 'github:dmtrKovalenko/fff': { version: '0.11.0' } },
          env: { GH_HOST: 'github.int.exe.xyz', NODE_ENV: 'development' },
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
      description: 'a recipe claude_md typo',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('"gcp"', '"gpc"') },
      message:
        'recipes/personal.toml lists claude_md "gpc", but claude/claude_md/gpc.md doesn\'t exist.',
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
      description: "a recipe tag exe.dev can't hold",
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace(
          'label = "Personal"\n',
          'label = "Personal"\ntags = ["Work GH"]\n',
        ),
      },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
    },
    {
      description: "a recipe tag that is another recipe's",
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace(
          'label = "Personal"\n',
          'label = "Personal"\ntags = ["pie-recipe-work"]\n',
        ),
      },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
    },
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
      description: 'settings that do not parse as JSON',
      overrides: { 'claude/settings/default.json': '{ "model": "opus", }\n' },
      errorClass: ConfigFileUnparseable,
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
      description: 'a repository dir that climbs out of ~/workspace',
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace('dir = "nidus"', 'dir = "../../.ssh"'),
      },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
    },
    {
      description: 'an absolute repository dir',
      overrides: { 'recipes/personal.toml': RECIPE_TOML.replace('dir = "nidus"', 'dir = "/etc"') },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
    },
    {
      description: 'a repository named with a .. part',
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace('"jliocsar/pie"', '"jliocsar/.."'),
      },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
    },
    {
      description: 'an integration that is no hostname label',
      overrides: {
        'recipes/personal.toml': RECIPE_TOML.replace(
          'integration = "hapana-gh-git"',
          'integration = "evil.example/x"',
        ),
      },
      errorClass: ConfigFileInvalid,
      filePath: 'recipes/personal.toml',
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
