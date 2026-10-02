import * as Command from 'effect/unstable/cli/Command'
import { check } from './commands/Check.ts'
import { pod } from './commands/Pod.ts'
import { sync } from './commands/Sync.ts'

export const pie = Command.make('pie').pipe(
  Command.withDescription('A recipe manager for exe.dev VMs.'),
  Command.withSubcommands([pod, check, sync]),
)
