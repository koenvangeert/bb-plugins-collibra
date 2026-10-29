import { definePluginApp } from '@get-bb/plugin-sdk/app'

function ThreadRunPanel() {
  return <p className="text-sm text-muted-foreground">No BETTY run for this thread yet.</p>
}

export default definePluginApp((app) => {
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
