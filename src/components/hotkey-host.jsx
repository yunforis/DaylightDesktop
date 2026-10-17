import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '@/context/workspace';
import { matchHotkey, readHotkeys } from '@/lib/hotkeys';

/** 监听可配置全局快捷键。 */
export function HotkeyHost() {
  const navigate = useNavigate();
  const { setCommandOpen, setEventModal, sync } = useWorkspace();
  const [hotkeys, setHotkeys] = useState(() => readHotkeys());
  const sequenceRef = useRef([]);

  useEffect(() => {
    function onStorage() {
      setHotkeys(readHotkeys());
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('daylight:hotkeys-changed', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('daylight:hotkeys-changed', onStorage);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      const id = matchHotkey(hotkeys, event, sequenceRef.current);
      const key = String(event.key || '').toLowerCase();
      if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        sequenceRef.current = [...sequenceRef.current, key].slice(-2);
        window.setTimeout(() => {
          sequenceRef.current = [];
        }, 800);
      }
      if (!id) return;
      event.preventDefault();
      sequenceRef.current = [];
      if (id === 'search') setCommandOpen(true);
      if (id === 'newEvent') setEventModal({ event: null, date: null });
      if (id === 'sync') sync('qq');
      if (id === 'goOverview') navigate('/app');
      if (id === 'goCalendar') navigate('/app/calendar');
      if (id === 'goTodos') navigate('/app/todos');
      if (id === 'goMail') navigate('/app/mail');
      if (id === 'goSettings') navigate('/app/settings');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys, navigate, setCommandOpen, setEventModal, sync]);

  return null;
}
