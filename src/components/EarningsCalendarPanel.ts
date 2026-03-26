import type { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

let _client: MarketServiceClient | null = null;
async function getMarketClient(): Promise<MarketServiceClient> {
  if (!_client) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

interface EarningsEntry {
  symbol: string;
  company: string;
  date: string;
  hour: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
  hasActuals: boolean;
  surpriseDirection: string;
}

function fmtDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch {
    return dateStr;
  }
}

function fmtEps(v: number | null): string {
  if (v == null) return '';
  return v.toFixed(2);
}

function renderEntry(e: EarningsEntry): string {
  const hourLabel = e.hour === 'bmo' ? 'BMO' : e.hour === 'amc' ? 'AMC' : e.hour.toUpperCase();
  const hourColor = e.hour === 'bmo'
    ? 'background:rgba(46,204,113,0.15);color:#2ecc71'
    : 'background:rgba(52,152,219,0.15);color:#3498db';

  const epsEst = fmtEps(e.epsEstimate);
  const epsAct = fmtEps(e.epsActual);

  let rightSection = '';
  if (e.hasActuals && epsAct) {
    const badgeColor = e.surpriseDirection === 'beat'
      ? 'background:rgba(46,204,113,0.2);color:#2ecc71'
      : e.surpriseDirection === 'miss'
        ? 'background:rgba(231,76,60,0.2);color:#e74c3c'
        : 'background:rgba(255,255,255,0.08);color:var(--text-dim)';
    const badgeLabel = e.surpriseDirection === 'beat' ? 'BEAT' : e.surpriseDirection === 'miss' ? 'MISS' : '';
    rightSection = `
      <span style="font-size:11px;color:var(--text-dim)">EPS ${escapeHtml(epsAct)}</span>
      ${badgeLabel ? `<span style="font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;${badgeColor}">${escapeHtml(badgeLabel)}</span>` : ''}`;
  } else if (epsEst) {
    rightSection = `<span style="font-size:11px;color:var(--text-dim)">est ${escapeHtml(epsEst)}</span>`;
  }

  return `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <span style="font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;${hourColor};flex-shrink:0">${escapeHtml(hourLabel)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.symbol)}</div>
        <div style="font-size:10px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.company)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">${rightSection}</div>
    </div>`;
}

function renderGroup(date: string, entries: EarningsEntry[]): string {
  return `
    <div style="font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;padding:10px 0 4px;border-top:1px solid rgba(255,255,255,0.06)">${escapeHtml(fmtDate(date))}</div>
    ${entries.map(renderEntry).join('')}`;
}

export class EarningsCalendarPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'earnings-calendar', title: 'Earnings Calendar', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    return this.refreshFromRpc();
  }

  private async refreshFromRpc(): Promise<boolean> {
    try {
      const client = await getMarketClient();
      const today = new Date();
      const future = new Date();
      future.setDate(future.getDate() + 14);
      const fromDate = today.toISOString().slice(0, 10);
      const toDate = future.toISOString().slice(0, 10);
      const resp = await client.listEarningsCalendar({ fromDate, toDate });

      if (resp.unavailable || !resp.earnings?.length) {
        if (!this._hasData) this.showError('No earnings data', () => void this.fetchData());
        return false;
      }

      this.render(resp.earnings as EarningsEntry[]);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private render(earnings: EarningsEntry[]): void {
    this._hasData = true;

    const grouped = new Map<string, EarningsEntry[]>();
    for (const e of earnings) {
      const key = e.date || 'Unknown';
      const arr = grouped.get(key);
      if (arr) arr.push(e);
      else grouped.set(key, [e]);
    }

    const sortedDates = [...grouped.keys()].sort();

    const html = `
      <div style="padding:0 14px 12px;max-height:480px;overflow-y:auto">
        ${sortedDates.map(d => renderGroup(d, grouped.get(d)!)).join('')}
      </div>`;

    this.setContent(html);
  }
}
