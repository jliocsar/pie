import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import { runGit } from '../Pod.ts'

export const CONFIG_REPOSITORY = 'jliocsar/agents-machines'

const REGULAR_FILE_MODE = 0o644

const EXECUTABLE_FILE_MODE = 0o755

export const SEED_CONFIG_FILES = {
  'recipes/personal.toml': `#:schema ../.pie/schema/recipe.json
label = "Personal"
environment = "personal"
repositories = ["jliocsar/pie", { repo = "jliocsar/nidus", dir = "nidus" }]
skills = ["handoff"]
mcp = ["fff", "docs"]

[claude]
agents = ["oracle"]
settings = "default"
`,
  'environments/personal.toml': `#:schema ../.pie/schema/environment.json
label = "Personal"
tasks = ["workspace"]

[tools]
node = "24.19.0"
"github:dmtrKovalenko/fff" = { version = "0.10.6", matching = "fff-mcp", bin = "fff-mcp" }

[env]
GH_HOST = "github.int.exe.xyz"
`,
  'mcp/fff.toml': '#:schema ../.pie/schema/mcp.json\ncommand = "fff-mcp"\n',
  'mcp/docs.toml': '#:schema ../.pie/schema/mcp.json\nurl = "https://docs.example/mcp"\n',
  'claude/agents/oracle.md':
    '---\nname: oracle\ndescription: answers questions\n---\nYou answer.\n',
  'claude/agents/unused.md': '---\nname: unused\ndescription: in no recipe\n---\n',
  'claude/settings/default.json': '{ "model": "opus", "includeCoAuthoredBy": false }\n',
  'skills/handoff/SKILL.md': '---\nname: handoff\ndescription: writes a handoff\n---\nWrite.\n',
  'skills/handoff/scripts/greet': '#!/bin/sh\necho hi\n',
  'tasks/workspace': '#!/bin/sh\nmkdir -p "$HOME/workspace"\n',
} satisfies Record.ReadonlyRecord<string, string>

const SEED_EXECUTABLE_FILE_PATHS = ['skills/handoff/scripts/greet', 'tasks/workspace']

export const inFreshDirectory = <Success, Failure, Requirements>(
  useDirectory: (temporaryDirectory: string) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped()

    return yield* useDirectory(temporaryDirectory)
  }).pipe(Effect.scoped)

export const commitToConfigSource = Effect.fn('commitToConfigSource')(function* (
  sourceDirectory: string,
  configFiles: Record.ReadonlyRecord<string, string>,
  executableFilePaths: readonly string[],
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* Effect.forEach(
    Record.toEntries(configFiles),
    ([filePath, content]) => {
      const absoluteFilePath = path.join(sourceDirectory, filePath)

      return fileSystem.makeDirectory(path.dirname(absoluteFilePath), { recursive: true }).pipe(
        Effect.andThen(
          fileSystem.writeFileString(absoluteFilePath, content, {
            mode: Arr.contains(executableFilePaths, filePath)
              ? EXECUTABLE_FILE_MODE
              : REGULAR_FILE_MODE,
          }),
        ),
      )
    },
    { discard: true },
  )
  yield* runGit(['-C', sourceDirectory, 'add', '--all'])
  yield* runGit([
    '-C',
    sourceDirectory,
    '-c',
    'user.name=pie',
    '-c',
    'user.email=pie@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--message',
    Record.keys(configFiles).join(' '),
  ])
})

export const makeConfigSource = Effect.fn('makeConfigSource')(function* (
  temporaryDirectory: string,
) {
  const path = yield* Path.Path
  const githubDirectory = path.join(temporaryDirectory, 'github')
  const sourceDirectory = path.join(githubDirectory, `${CONFIG_REPOSITORY}.git`)

  yield* runGit(['init', '--quiet', sourceDirectory])
  yield* commitToConfigSource(sourceDirectory, SEED_CONFIG_FILES, SEED_EXECUTABLE_FILE_PATHS)

  return { githubDirectory, sourceDirectory }
})
