/**
 * Virtual clock.
 *
 * Recovery policy plays out over days: retry at +2h, +26h, after payday.
 * A pitch video is five minutes. So the whole system reads time through this
 * clock, and the simulator runs it fast. Nothing else in the codebase knows
 * the difference -- the scheduler, the ML features and the ledger all just
 * ask for `now()`.
 *
 * speed = 3600 means one real second is one virtual hour, so a 7-day retry
 * window completes in about three real minutes.
 */
class Clock {
  private origin = Date.now();
  private virtualOrigin = Date.now();
  speed = 1;

  setSpeed(s: number) {
    // Re-anchor so virtual time is continuous across a speed change.
    this.virtualOrigin = this.now();
    this.origin = Date.now();
    this.speed = Math.max(1, s);
  }

  now(): number {
    return this.virtualOrigin + (Date.now() - this.origin) * this.speed;
  }

  date(): Date {
    return new Date(this.now());
  }

  /** Real milliseconds to wait for a given number of virtual milliseconds. */
  realDelay(virtualMs: number): number {
    return virtualMs / this.speed;
  }

  /**
   * Resume virtual time where a previous process left off.
   *
   * Retries are scheduled at VIRTUAL timestamps. Run the clock at 2 hours a
   * second for a few minutes and those timestamps sit weeks ahead of real
   * time -- so a plain restart, which re-anchors virtual time to Date.now(),
   * silently strands every queued retry somewhere in its own future. The
   * queue looks full and nothing ever fires. Persisting the anchor keeps
   * virtual time continuous across restarts, which is what the scheduler
   * already assumes.
   */
  hydrate(virtualNow: number) {
    if (!Number.isFinite(virtualNow) || virtualNow <= 0) return;
    this.virtualOrigin = Math.max(virtualNow, this.virtualOrigin);
    this.origin = Date.now();
  }

  reset() {
    this.origin = Date.now();
    this.virtualOrigin = Date.now();
  }
}

export const clock = new Clock();
export const HOUR = 3600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;
