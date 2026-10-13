export type ReplayClockPhase = 'idle' | 'paused' | 'playing';

export interface ReplayClockSnapshot {
  phase: ReplayClockPhase;
  cursor: number;
  total: number;
  speed: number;
  currentTime: number | null;
}

export type ReplayClockStep = (cursor: number, currentTime: number) => void;
export type ReplayClockChange = (snapshot: ReplayClockSnapshot) => void;

const SPEEDS = [1, 2, 5, 10] as const;

export class ReplayClock {
  private timeline: number[] = [];
  private cursor = -1;
  private speed = 1;
  private phase: ReplayClockPhase = 'idle';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onStep: ReplayClockStep,
    private readonly onChange: ReplayClockChange = () => undefined,
  ) {}

  snapshot(): ReplayClockSnapshot {
    return {
      phase: this.phase,
      cursor: this.cursor,
      total: this.timeline.length,
      speed: this.speed,
      currentTime: this.cursor >= 0 ? this.timeline[this.cursor] ?? null : null,
    };
  }

  /** Nap timeline chung. Moi moc thoi gian la luc mot raw candle da dong va duoc phep hien thi. */
  load(timeline: readonly number[], startCursor: number): void {
    this.stopTimer();
    this.timeline = [...timeline];
    if (this.timeline.length === 0) {
      this.cursor = -1;
      this.phase = 'idle';
      this.emitChange();
      return;
    }
    this.cursor = Math.min(Math.max(0, startCursor), this.timeline.length - 1);
    this.phase = 'paused';
    this.emitChange();
  }

  play(): void {
    if (this.phase === 'idle' || this.cursor >= this.timeline.length - 1) return;
    this.stopTimer();
    this.phase = 'playing';
    this.timer = setInterval(() => this.step(), Math.max(100, 1000 / this.speed));
    this.emitChange();
  }

  pause(): void {
    if (this.phase === 'idle') return;
    this.stopTimer();
    this.phase = 'paused';
    this.emitChange();
  }

  togglePlayback(): void {
    if (this.phase === 'playing') this.pause();
    else this.play();
  }

  step(): boolean {
    if (this.phase === 'idle' || this.cursor >= this.timeline.length - 1) {
      if (this.phase === 'playing') {
        this.stopTimer();
        this.phase = 'paused';
        this.emitChange();
      }
      return false;
    }

    this.cursor += 1;
    const currentTime = this.timeline[this.cursor];
    this.onStep(this.cursor, currentTime);
    if (this.cursor >= this.timeline.length - 1) {
      this.stopTimer();
      this.phase = 'paused';
    }
    this.emitChange();
    return true;
  }

  cycleSpeed(): number {
    const index = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(index + 1) % SPEEDS.length];
    this.setSpeed(next);
    return next;
  }

  setSpeed(speed: number): void {
    if (!SPEEDS.includes(speed as (typeof SPEEDS)[number])) return;
    const wasPlaying = this.phase === 'playing';
    this.speed = speed;
    if (wasPlaying) {
      this.stopTimer();
      this.timer = setInterval(() => this.step(), Math.max(100, 1000 / this.speed));
    }
    this.emitChange();
  }

  stop(): void {
    this.stopTimer();
    this.timeline = [];
    this.cursor = -1;
    this.speed = 1;
    this.phase = 'idle';
    this.emitChange();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private emitChange(): void {
    this.onChange(this.snapshot());
  }
}
