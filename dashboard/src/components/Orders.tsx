import { useState } from 'react';
import type { Order } from '../lib/api';
import { usePoll, rupees } from '../lib/api';
import OrderDrawer from './OrderDrawer';

/** Orders that needed recovery. Click any row for the full trace. */
export default function Orders() {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const { data } = usePoll<{ orders: Order[] }>(
    `/api/orders?limit=40${filter ? `&status=${filter}` : ''}`,
    3000,
  );
  const rows = data?.orders ?? [];

  return (
    <>
      <div className="panel">
        <header>
          <h2>Orders in recovery</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginLeft: 'auto' }}>
            <option value="">all</option>
            <option value="recovering">recovering</option>
            <option value="paid">paid</option>
            <option value="abandoned">abandoned</option>
          </select>
          <p>Click a row to see every attempt, the reasoning behind each decision, and the money.</p>
        </header>
        <div className="body flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>Last decline</th>
                  <th>Cohort</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      nothing in recovery yet — start the simulator
                    </td>
                  </tr>
                )}
                {rows.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => setOpen(o.id)}>
                    <td className="mono" style={{ fontSize: 11.6 }}>
                      {o.id.replace('order_', '').slice(0, 10)}
                    </td>
                    <td className="num">₹{rupees(o.amount_paise)}</td>
                    <td>
                      <span
                        className={`pill ${
                          o.status === 'paid' ? 'ok' : o.status === 'abandoned' ? 'neutral' : 'accent'
                        }`}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="num">{o.attempts}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {o.last_reason ?? '—'}
                      {o.decline_class && (
                        <span className={`pill ${o.decline_class === 'hard' ? 'crit' : 'neutral'}`} style={{ marginLeft: 6 }}>
                          {o.decline_class}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${o.sim_recoverable ? 'neutral' : 'crit'}`}>
                        {o.sim_cohort}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {open && <OrderDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
