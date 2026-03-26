import type { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

let _client: EconomicServiceClient | null = null;
async function getEconomicClient(): Promise<EconomicServiceClient> {
  if (!_client) {
    const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

interface MacroTile {
  id: string;
  label: string;
  unit: string;
  value: number | null;
  prior: number | null;
  date: string;
  lowerIsBetter: boolean;
  neutral?: boolean;
  format: (v: number) => string;
  deltaFormat?: (v: number) => string;
}

function pctFmt(v: number): string {
  return `${v.toFixed(1)}%`;
}

function gdpFmt(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}B`;
}

function cpiYoY(obs: { date: string; value: number }[]): { value: number | null; prior: number | null; date: string } {
  if (obs.length < 13) return { value: null, prior: null, date: '' };
  const latest = obs[obs.length - 1];
  const yearAgo = obs[obs.length - 13];
  const priorMonth = obs[obs.length - 2];
  const priorYearAgo = obs[obs.length - 14] ?? obs[obs.length - 13];
  if (!latest || !yearAgo) return { value: null, prior: null, date: '' };
  const yoy = yearAgo.value > 0 ? ((latest.value - yearAgo.value) / yearAgo.value) * 100 : null;
  const priorYoy = (priorYearAgo && priorMonth && priorYearAgo.value > 0)
    ? ((priorMonth.value - priorYearAgo.value) / priorYearAgo.value) * 100
    : null;
  return { value: yoy, prior: priorYoy, date: latest.date };
}

function lastTwo(obs: { date: string; value: number }[]): { value: number | null; prior: number | null; date: string } {
  const last = obs[obs.length - 1];
  if (!obs.length || !last) return { value: null, prior: null, date: '' };
  const prev = obs[obs.length - 2];
  return {
    value: last.value,
    prior: prev?.value ?? null,
    date: last.date,
  };
}

function deltaColor(delta: number, lowerIsBetter: boolean, neutral: boolean): string {
  if (neutral) return 'var(--text-dim)';
  if (delta === 0) return 'var(--text-dim)';
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return improved ? '#27ae60' : '#e74c3c';
}

function tileHtml(tile: MacroTile): string {
  const val = tile.value !== null ? escapeHtml(tile.format(tile.value)) : 'N/A';
  const delta = tile.value !== null && tile.prior !== null ? tile.value - tile.prior : null;
  const fmt = tile.deltaFormat ?? tile.format;
  const deltaStr = delta !== null
    ? `${delta >= 0 ? '+' : ''}${fmt(delta)} vs prior`
    : '';
  const deltaColor_ = delta !== null ? deltaColor(delta, tile.lowerIsBetter, tile.neutral ?? false) : 'var(--text-dim)';

  return `<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:14px 12px;display:flex;flex-direction:column;gap:4px">
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.07em">${escapeHtml(tile.label)}</div>
    <div style="font-size:28px;font-weight:700;color:var(--text);line-height:1.1;font-variant-numeric:tabular-nums">${val}</div>
    ${deltaStr ? `<div style="font-size:11px;color:${deltaColor_}">${escapeHtml(deltaStr)}</div>` : ''}
    <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(tile.date)}</div>
  </div>`;
}

export class MacroTilesPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'macro-tiles', title: 'Macro Indicators', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const client = await getEconomicClient();
      const resp = await client.getFredSeriesBatch({
        seriesIds: ['CPIAUCSL', 'UNRATE', 'GDP', 'FEDFUNDS'],
        limit: 14,
      });

      const cpiObs = resp.results['CPIAUCSL']?.observations ?? [];
      const unrateObs = resp.results['UNRATE']?.observations ?? [];
      const gdpObs = resp.results['GDP']?.observations ?? [];
      const fedObs = resp.results['FEDFUNDS']?.observations ?? [];

      const cpi = cpiYoY(cpiObs);
      const unrate = lastTwo(unrateObs);
      const gdp = lastTwo(gdpObs);
      const fed = lastTwo(fedObs);

      const tiles: MacroTile[] = [
        { id: 'cpi', label: 'CPI (YoY)', unit: '%', ...cpi, lowerIsBetter: true, format: pctFmt, deltaFormat: (v) => v.toFixed(2) },
        { id: 'unrate', label: 'Unemployment', unit: '%', ...unrate, lowerIsBetter: true, format: pctFmt },
        { id: 'gdp', label: 'GDP (Billions)', unit: '$B', ...gdp, lowerIsBetter: false, format: gdpFmt, deltaFormat: (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}B` },
        { id: 'fed', label: 'Fed Funds Rate', unit: '%', ...fed, lowerIsBetter: false, neutral: true, format: pctFmt },
      ];

      const hasAny = tiles.some(t => t.value !== null);
      if (!hasAny) {
        if (!this._hasData) this.showError('Macro data unavailable', () => void this.fetchData());
        return false;
      }

      this._hasData = true;
      const html = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">${tiles.map(tileHtml).join('')}</div>`;
      this.setContent(html);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }
}
