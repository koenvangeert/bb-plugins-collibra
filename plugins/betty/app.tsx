import { definePluginApp } from '@get-bb/plugin-sdk/app'
import { RunsPage } from './src/ui/RunsPage'
import { SignInGate } from './src/ui/SignInGate'

function ThreadRunPanel() {
  return (
    <SignInGate>
      <p className="text-sm text-muted-foreground">No BETTY run for this thread yet.</p>
    </SignInGate>
  )
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: 'runs', title: 'BETTY', icon: 'Workflow', path: 'runs', component: RunsPage })
  app.slots.experimental_tab({
    context: { kind: 'thread' },
    availability: 'action',
    id: 'betty-run',
    title: 'BETTY run',
    icon: 'Workflow',
    layout: 'padded',
    component: ThreadRunPanel,
    run: ({ openPanel }) => {
      openPanel()
    },
  })
})
