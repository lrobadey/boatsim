import { goodById, type GoodId } from './goods';
import { jobSummary } from './job';
import type { CargoJob } from './voyage';

export type HandlingPhase = 'load' | 'unload' | 'paused' | 'ready' | 'idle';

export interface HandlingContext {
  connected: boolean;
  portName?: string;
}

export interface HandlingStatus {
  phase: HandlingPhase;
  good: GoodId | null;
  units: number;
  hours: number;
  label: string;
  detail: string;
}

/** Whole game minutes, rounded up while work remains so the display never promises early completion. */
export function formatHandlingDuration(hours: number): string {
  if (hours <= 0) return '0 min';
  const minutes = Math.max(1, Math.ceil(hours * 60 - 1e-10));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** Shared pure status for the open book and the dockside HUD. */
export function handlingStatus(
  job: CargoJob | null | undefined,
  T: number,
  hatchUntil: number | null | undefined,
  context?: HandlingContext,
): HandlingStatus {
  if (job) {
    const summary = jobSummary(job);
    if (summary.units > 0 && summary.phase && summary.good) {
      const phase = summary.phase;
      const good = summary.good;
      if (context?.connected === false) {
        const portName = context.portName ?? `port ${job.port}`;
        return {
          phase: 'paused', good, units: summary.units, hours: summary.hours,
          label: 'Handling paused',
          detail: `Return to ${portName} berth · ${summary.units} left`,
        };
      }
      const label = `${phase === 'load' ? 'Loading' : 'Unloading'} ${goodById(good).name.toLowerCase()}`;
      const detail = `${summary.units} left · ${formatHandlingDuration(summary.hours)}`;
      return { phase, good, units: summary.units, hours: summary.hours, label, detail };
    }
    // An empty job still owns the one-hour cart delay after its last package crossed.
    return { phase: 'ready', good: null, units: 0, hours: 0, label: 'Cargo handled', detail: 'Ready to cast off' };
  }
  if (hatchUntil != null && hatchUntil > T) {
    return { phase: 'ready', good: null, units: 0, hours: 0, label: 'Cargo handled', detail: 'Ready to cast off' };
  }
  return { phase: 'idle', good: null, units: 0, hours: 0, label: '', detail: '' };
}
