import * as Command from 'effect/unstable/cli/Command'
import { pod } from './commands/Pod.ts'
import { sync } from './commands/Sync.ts'

export const pie = Command.make('pie').pipe(Command.withSubcommands([pod, sync]))
