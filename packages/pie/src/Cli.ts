import * as Command from 'effect/unstable/cli/Command'
import { bootstrap } from './commands/Bootstrap.ts'
import { invite } from './commands/Invite.ts'
import { join } from './commands/Join.ts'
import { pods } from './commands/Pods.ts'
import { serve } from './commands/Serve.ts'
import { pod } from './commands/Up.ts'

export const pie = Command.make('pie').pipe(
  Command.withSubcommands([serve, bootstrap, join, invite, pods, pod]),
)
