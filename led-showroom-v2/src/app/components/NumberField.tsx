import { useEffect, useRef, useState } from 'react';
import { formatLength, fromInches, parseLength, toInches, unitDecimals, unitStepInches, type Unit } from '@/engine/units';

/* ───────── generic numeric field with label-scrub and math ───────── */

export interface NumberFieldProps {
  value: number;
  onChange(v: number): void;
  /** Called when a scrub/drag ends (commit history). */
  onCommit?(): void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown. */
  decimals?: number;
  /** Short scrub handle text ("X", "W", "°"). */
  scrub?: string;
  axis?: 'x' | 'y' | 'z';
  unit?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
  /** Scrub sensitivity: value change per pixel. */
  scrubSpeed?: number;
  /** Step used while Shift is held (default step × 10). */
  coarseStep?: number;
}

function evalMath(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!t) return null;
  if (/^-?\d*\.?\d+$/.test(t)) return parseFloat(t);
  if (/^[\d\s.+\-*/()]+$/.test(t)) {
    try { const v = Function(`"use strict"; return (${t});`)(); if (typeof v === 'number' && Number.isFinite(v)) return v; } catch { /* ignore */ }
  }
  return null;
}

export function NumberField({ value, onChange, onCommit, min = -Infinity, max = Infinity, step = 1, decimals = 2, scrub, axis, unit, disabled, placeholder, className = '', title, scrubSpeed, coarseStep }: NumberFieldProps) {
  const coarse = coarseStep ?? step * 10;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);

  const fmt = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(decimals)) : '');
  useEffect(() => { if (!editing) setText(fmt(value)); }, [value, editing, decimals]);

  const clampv = (v: number) => Math.min(max, Math.max(min, v));

  const commitText = () => {
    const v = evalMath(text);
    if (v === null) { setInvalid(true); setText(fmt(value)); setEditing(false); window.setTimeout(() => setInvalid(false), 600); return; }
    const c = clampv(v);
    if (c !== value) onChange(c);
    onCommit?.();
    setEditing(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { commitText(); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') { setText(fmt(value)); setEditing(false); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const s = (e.shiftKey ? coarse : e.altKey ? step * 0.1 : step) * (e.key === 'ArrowUp' ? 1 : -1);
      const v = clampv(+(value + s).toFixed(6));
      onChange(v); setText(fmt(v));
    }
  };

  const onScrubDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    e.preventDefault();
    drag.current = { x: e.clientX, start: value, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) < 2 && !d.moved) return;
    d.moved = true;
    const base = scrubSpeed ?? step;
    const speed = e.shiftKey ? (scrubSpeed !== undefined ? base * 10 : coarse) : e.altKey ? base * 0.1 : base;
    const v = clampv(+(d.start + dx * speed).toFixed(6));
    onChange(v);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d?.moved) onCommit?.();
  };

  const cls = ['field', axis ? `axis-${axis}` : '', invalid ? 'invalid' : '', className].filter(Boolean).join(' ');
  return (
    <div className={cls} title={title}>
      {scrub !== undefined && (
        <span className="scrub" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp}>{scrub}</span>
      )}
      <input
        type="text" inputMode="decimal" value={text} disabled={disabled} placeholder={placeholder}
        onFocus={e => { setEditing(true); e.target.select(); }}
        onChange={e => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={onKey}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

/* ───────── length field: stores inches, displays the user's unit ───────── */

export interface LengthFieldProps {
  inches: number;
  unit: Unit;
  onChange(inches: number): void;
  onCommit?(): void;
  min?: number;
  max?: number;
  scrub?: string;
  axis?: 'x' | 'y' | 'z';
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Fine step (default: unit-specific). */
  stepIn?: number;
}

export function LengthField({ inches, unit, onChange, onCommit, min = -Infinity, max = Infinity, scrub, axis, disabled, className = '', title, stepIn }: LengthFieldProps) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const step = stepIn ?? unitStepInches(unit, true);

  const display = (v: number) => {
    if (!Number.isFinite(v)) return '';
    if (unit === 'ft') return formatLength(v, 'ft');
    return String(+fromInches(v, unit).toFixed(unitDecimals(unit)));
  };
  useEffect(() => { if (!editing) setText(display(inches)); }, [inches, unit, editing]);

  const clampv = (v: number) => Math.min(max, Math.max(min, v));

  const commitText = () => {
    const v = parseLength(text, unit);
    if (v === null) { setInvalid(true); setText(display(inches)); setEditing(false); window.setTimeout(() => setInvalid(false), 600); return; }
    const c = clampv(v);
    if (Math.abs(c - inches) > 1e-9) onChange(c);
    onCommit?.();
    setEditing(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { commitText(); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') { setText(display(inches)); setEditing(false); (e.target as HTMLInputElement).blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const s = (e.shiftKey ? unitStepInches(unit, false) : step) * (e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const v = clampv(inches + s);
      onChange(v); setText(display(v));
    }
  };

  const onScrubDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    e.preventDefault();
    drag.current = { x: e.clientX, start: inches, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) < 2 && !d.moved) return;
    d.moved = true;
    const perPx = (e.shiftKey ? unitStepInches(unit, false) : step) * (e.altKey ? 0.1 : 1);
    onChange(clampv(d.start + dx * perPx));
  };
  const onScrubUp = (e: React.PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d?.moved) onCommit?.();
  };

  const cls = ['field', axis ? `axis-${axis}` : '', invalid ? 'invalid' : '', className].filter(Boolean).join(' ');
  return (
    <div className={cls} title={title}>
      {scrub !== undefined && (
        <span className="scrub" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp}>{scrub}</span>
      )}
      <input
        type="text" inputMode="decimal" value={text} disabled={disabled}
        onFocus={e => { setEditing(true); e.target.select(); }}
        onChange={e => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={onKey}
      />
      {unit !== 'ft' && <span className="unit">{unit === 'in' ? 'in' : unit}</span>}
    </div>
  );
}

/** Convert a typed value in display units to inches (helper for ad-hoc inputs). */
export const displayToInches = (v: number, unit: Unit): number => toInches(v, unit);
