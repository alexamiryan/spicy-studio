import { useEffect, useRef, useState } from 'react';

const MEDIA = /^(image|video|audio)\//;

function mediaFiles(list: FileList | null | undefined) {
  return Array.from(list || []).filter(f => MEDIA.test(f.type) || /\.(heic|heif)$/i.test(f.name));
}

/**
 * Drop files onto an element. Returns `over` (to highlight the drop zone) and props to spread on it.
 * Ignores drags that don't carry files (e.g. dragging results onto folders).
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0); // dragenter/leave fire for every child; count to avoid flicker
  const hasFiles = (e: React.DragEvent) => enabled && e.dataTransfer.types.includes('Files');
  return {
    over,
    props: {
      onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); },
      onDragOver: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
      onDragLeave: (e: React.DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = mediaFiles(e.dataTransfer.files);
        if (files.length) onFiles(files);
      },
    },
  };
}

/** Paste images/videos from the clipboard (Ctrl/Cmd+V, or Paste on phones) while `enabled`. Text pastes are untouched. */
export function usePasteFiles(onFiles: (files: File[]) => void, enabled: boolean) {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = mediaFiles(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      handler.current(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [enabled]);
}
