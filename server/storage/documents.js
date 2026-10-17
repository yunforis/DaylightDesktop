/** app_settings documents needed by synchronous auxiliary modules.
 * The storage loader must apply mailbox ownership checks before loading mailbox keys.
 * Missing rows use these defaults; importing local files is an explicit migration.
 */
export function auxiliarySnapshotDocuments(mailboxIds = []) {
  return [
    { id: 'prompts', initial: {} },
    { id: 'report-prompts', initial: {} },
    { id: 'mail-templates', initial: {} },
    { id: 'aux-prompt-revisions', initial: [] },
    ...mailboxIds.flatMap((id) => [
      { id: `external-sync:${id}`, initial: { intents: [], targets: {} } },
      { id: `traces:${id}`, initial: [] },
      { id: `recruitment:${id}`, initial: { candidates: [], attachments: [], messages: [], interviews: [], traces: [] } },
    ]),
  ];
}
