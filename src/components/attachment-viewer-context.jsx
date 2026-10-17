import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AttachmentPreview } from '@/components/attachment-viewer';
import { openAttachmentViewer as openShared, setAttachmentOpener } from '@/lib/attachment-open';

const AttachmentViewerContext = createContext(null);

export { openShared as openAttachmentViewer };

export function AttachmentViewerProvider({ children }) {
  const [file, setFile] = useState(null);

  const open = useCallback((next) => {
    if (!next) return;
    setFile(next);
  }, []);

  const close = useCallback(() => setFile(null), []);

  useEffect(() => {
    setAttachmentOpener(open);
    return () => setAttachmentOpener(null);
  }, [open]);

  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <AttachmentViewerContext.Provider value={value}>
      {children}
      {file ? (
        <AttachmentPreview
          file={file}
          open={Boolean(file)}
          onOpenChange={(next) => { if (!next) close(); }}
        />
      ) : null}
    </AttachmentViewerContext.Provider>
  );
}

export function useAttachmentViewer() {
  const ctx = useContext(AttachmentViewerContext);
  if (!ctx) {
    return { open: openShared, close: () => {} };
  }
  return ctx;
}
