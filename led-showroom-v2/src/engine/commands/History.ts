/**
 * Undo/redo history. Every document mutation is a Command. Commands with the same `mergeKey`
 * executed back-to-back (e.g. successive frames of a drag) coalesce into one history entry so
 * a single Ctrl+Z reverts the whole gesture.
 */
export interface Command {
  /** Human label shown in the Edit menu / toast ("Move Wall 1"). */
  label: string;
  /** Apply the change. Called once on run, and again on redo. */
  do(): void;
  /** Revert the change. Must restore exactly the pre-`do` state. */
  undo(): void;
  /** Consecutive commands sharing a mergeKey collapse into one entry (the first `undo`, the last `do`). */
  mergeKey?: string;
  /** If true, the command is executed but not recorded (e.g. camera moves, hover). */
  transient?: boolean;
}

interface Entry { label: string; undo: () => void; redo: () => void; mergeKey?: string; at: number }

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();
  /** Merge window in ms: commands with the same key within this window coalesce. */
  mergeWindowMs = 1500;
  limit = 200;

  run(cmd: Command): void {
    cmd.do();
    if (cmd.transient) return;
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (cmd.mergeKey && top && top.mergeKey === cmd.mergeKey && now - top.at < this.mergeWindowMs) {
      // keep the original undo, replace redo with the latest do
      top.redo = () => cmd.do();
      top.at = now;
      top.label = cmd.label;
    } else {
      this.undoStack.push({ label: cmd.label, undo: () => cmd.undo(), redo: () => cmd.do(), mergeKey: cmd.mergeKey, at: now });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.notify();
  }

  /** Close the merge window so the next command with the same key starts a fresh entry. */
  commit(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.at = 0;
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this.notify();
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this.notify();
    return e.label;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null { return this.undoStack[this.undoStack.length - 1]?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack[this.redoStack.length - 1]?.label ?? null; }

  clear(): void { this.undoStack.length = 0; this.redoStack.length = 0; this.notify(); }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify(): void { for (const fn of this.listeners) fn(); }
}
