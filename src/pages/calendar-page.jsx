import React, { useState } from 'react';
import { StudioCalendar } from '@/components/studio-calendar';
import { matchesWorkbench, useWorkbenchOptions, WorkbenchFilter } from '@/components/workbench-filter';
import { useWorkspace } from '@/context/workspace';
import { eventTime, shanghaiDate } from '@/lib/time';

export default function CalendarPage() {
  const { events, setEventModal, state, reload, deleteEvent } = useWorkspace();
  const { workbenches, loaded } = useWorkbenchOptions();
  const [workbenchId, setWorkbenchId] = useState('all');
  const shown = events.filter((event) => matchesWorkbench(event, workbenchId, loaded ? workbenches : null));
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <WorkbenchFilter value={workbenchId} onChange={setWorkbenchId} workbenches={workbenches} loaded={loaded} />
      </div>
    <StudioCalendar
      events={shown}
      categories={state?.settings?.calendarCategories}
      onCategoriesChange={reload}
      onEvent={(event) => setEventModal({ event, date: shanghaiDate(event.start) })}
      onNew={(date) => setEventModal({ event: null, date })}
      onDelete={async (event) => {
        if (!event?.id) return;
        await deleteEvent(event.id);
      }}
      onAskLittleD={(event) => {
        const title = event?.title || '该日程';
        const when = eventTime(event);
        window.dispatchEvent(new CustomEvent('daylight:open-little-d', {
          detail: {
            prompt: `请帮我看看日程「${title}」（${when}），有什么需要注意或可以调整的？`,
          },
        }));
      }}
    />
    </div>
  );
}
