import { useRef, useState, type ReactNode } from 'react';

interface Props {
  accept: string;
  onFiles(files: File[]): void;
  icon?: ReactNode;
  label: ReactNode;
  hint?: string;
  multiple?: boolean;
  className?: string;
}

/** Click-to-browse / drag-and-drop file target. */
export function DropZone({ accept, onFiles, icon, label, hint, multiple, className = '' }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone${over ? ' over' : ''} ${className}`}
      onClick={() => input.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const files = Array.from(e.dataTransfer.files); if (files.length) onFiles(multiple ? files : [files[0]]); }}
      role="button"
    >
      {icon}
      <div>{label}</div>
      {hint && <div className="hint" style={{ fontSize: '10.5px' }}>{hint}</div>}
      <input ref={input} type="file" accept={accept} multiple={multiple} style={{ display: 'none' }}
        onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); e.target.value = ''; }} />
    </div>
  );
}
