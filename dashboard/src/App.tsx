import { useCallback, useEffect, useState } from 'react';
import { usePoll, post, get, num } from './lib/api';
import type { Metrics, Invariant, Decision, Rail, Cohort } from './lib/api';
import Headline from './components/Headline';
import Invariants from './components/Invariants';
import Chaos from './components/Chaos';
import Decisions from './components/Decisions';
import Rails from './components/Rails';
import Cohorts from './components/Cohorts';
import Model from './components/Model';
import Experiment from './components/Experiment';
import Orders from './components/Orders';

type Theme = 'system' | 'light' | 'dark';

export default function App() {
  const [theme, setTheme] = useState<Theme>('system');
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(3600);
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  const metrics = usePoll<Metrics>('/api/metrics', 1500);
  const invariants = usePoll<{ all_ok: boolean; invariants: Invariant[] }>('/api/invariants', 2000);
  const decisions = usePoll<{ decisions: Decision[] }>('/api/decisions?limit=25', 2000);
  const rails = usePoll<{ rails: Rail[] }>('/api/rails', 3000);
  const cohorts = usePoll<{ cohorts: Cohort[] }>('/api/cohorts', 3000);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('rebound-theme', theme);
    } catch {
      /* private window, blocked storage -- the page works the same without it */
    }
  }, [theme]);

  useEffect(() => {
    try {
      const t = localStorage.getItem('rebound-theme') as Theme | null;
      if (t) setTheme(t);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    get<{ ok: boolean }>('/health')
      .then((h) => setApiUp(h.ok))
      .catch(() => setApiUp(false));
    get<{ running: boolean; speed: number }>('/api/sim/status')
      .then((s) => {
        setRunning(s.running);
        setSpeed(s.speed);
      })
      .catch(() => {});
  }, []);

  const refreshAll = useCallback(() => {
    metrics.refresh();
    invariants.refresh();
    decisions.refresh();
    rails.refresh();
    cohorts.refresh();
  }, [metrics, invariants, decisions, rails, cohorts]);

  async function toggleSim() {
    if (running) {
      await post('/api/sim/stop');
      setRunning(false);
    } else {
      await post('/api/sim/start', { rate: 5, speed });
      setRunning(true);
    }
    refreshAll();
  }

  async function changeSpeed(s: number) {
    setSpeed(s);
    await post('/api/sim/speed', { speed: s });
  }

  const m = metrics.data;

  return (
    <>
      <div className="top">
        <div className="brand">
          <h1>Rebound</h1>
          <span>AI revenue recovery</span>
        </div>

        <span className={`pill ${apiUp === false ? 'crit' : apiUp ? 'ok' : 'neutral'}`}>
          <i className={`dot ${apiUp ? 'live' : ''}`} />
          {apiUp === null ? 'connecting' : apiUp ? 'api up' : 'api down'}
        </span>

        {m && (
          <span className="pill neutral">
            {num(m.orders)} orders · {num(m.worker?.queued)} queued
          </span>
        )}

        <span className="spacer" />

        <button className="primary" onClick={toggleSim} disabled={apiUp === false}>
          <span className="icon s18" aria-hidden="true" style={{ marginRight: 6 }}>
            {running ? 'pause_circle' : 'play_circle'}
          </span>
          {running ? 'Pause traffic' : 'Start traffic'}
        </button>

        <button
          onClick={async () => {
            await post('/api/sim/burst', { n: 60 });
            refreshAll();
          }}
          disabled={apiUp === false}
        >
          +60 orders
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
          <span style={{ color: 'var(--ink-3)' }}>clock</span>
          <select value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}>
            <option value={60}>1s = 1 min</option>
            <option value={3600}>1s = 1 hour</option>
            <option value={21600}>1s = 6 hours</option>
            <option value={86400}>1s = 1 day</option>
          </select>
        </label>

        <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          <option value="system">system</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </div>

      <main>
        {apiUp === false && (
          <div className="panel">
            <div className="body">
              <strong>The API is not responding.</strong>
              <p style={{ color: 'var(--ink-2)', marginBottom: 0 }}>
                Start it with <code className="mono">cd api &amp;&amp; npm run dev</code>, and make
                sure Postgres and Redis are up (
                <code className="mono">cd infra &amp;&amp; docker compose up -d</code>).
              </p>
            </div>
          </div>
        )}

        <Headline m={m} />

        <Experiment />

        <div className="grid-2">
          <Invariants data={invariants.data} />
          <Model />
        </div>

        <Chaos onDone={refreshAll} />

        <div className="grid-2">
          <Cohorts data={cohorts.data} />
          <Rails data={rails.data} />
        </div>

        <Orders />

        <Decisions data={decisions.data} />

      </main>

      <footer className="foot">
        <span className="icon s16" aria-hidden="true">
          science
        </span>
        <span>
          All traffic here is <strong>simulated</strong>. Cohorts, outage windows and recovery
          ceilings are planted by the generator — which is exactly what makes
          captured-of-recoverable measurable at all.
        </span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 11.5 }}>
          {m ? `${num(m.orders)} orders · clock ${m.clock?.speed}x` : 'connecting'}
        </span>
      </footer>
    </>
  );
}
