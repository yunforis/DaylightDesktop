import React from 'react';
import { StudioCalendar } from '@/components/studio-calendar';
import { useWorkspace } from '@/context/workspace';
import { shanghaiDate } from '@/lib/time';

export default function CalendarPage() {
  const { events, setEventModal, state, reload } = useWorkspace();
  return (
    <StudioCalendar
      events={events}
      categories={state?.settings?.calendarCategories}
      onCategoriesChange={reload}
      onEvent={(event) => setEventModal({ event, date: shanghaiDate(event.start) })}
      onNew={(date) => setEventModal({ event: null, date })}
    />
  );
}
