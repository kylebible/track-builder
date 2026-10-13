import type { Layout } from './layout';

/** Undo and redo over whole layout snapshots. Layouts are immutable, so this is cheap. */
export class History {
  private past: Layout[] = [];
  private future: Layout[] = [];

  constructor(
    public current: Layout,
    private readonly limit = 200,
  ) {}

  /** Record a new state. A no-op edit leaves the history alone. */
  push(next: Layout): void {
    if (next === this.current) return;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.current = next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): Layout {
    const previous = this.past.pop();
    if (previous) {
      this.future.push(this.current);
      this.current = previous;
    }
    return this.current;
  }

  redo(): Layout {
    const next = this.future.pop();
    if (next) {
      this.past.push(this.current);
      this.current = next;
    }
    return this.current;
  }
}
