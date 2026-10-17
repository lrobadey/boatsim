// The local calendar (docs/expectations-mvp-spec.md §6, docs/pass-1b-plan.md A). Pure: whole civil days
// counted by the clock's dayCount, lunar months from the same closed-form moon the sky shows.

/** Saved start values the calendar and the sky's moon are computed from. */
export interface CalendarEpoch {
  /** moon phase (0 = new) on dayCount 0 */
  moonPhase0: number;
  /** day of year (0..364) on dayCount 0 */
  doy0: number;
  version: 1;
}

export const LUNATION_DAYS = 29.53;
export const SOLSTICE_DOY = 172;
export const DEFAULT_EPOCH: CalendarEpoch = { moonPhase0: 0.43, doy0: 172, version: 1 };

export interface CalendarDate {
  /** Year 1 is the year holding dayCount 0 */
  year: number;
  /** 0-based month index within the year */
  month: number;
  monthName: string;
  /** 1-based day of the month */
  day: number;
  /** 29 or 30 */
  monthLength: number;
  /** true for Poseideon II */
  intercalary: boolean;
}

const MONTHS = [
  'Hekatombaion', 'Metageitnion', 'Boedromion', 'Pyanepsion', 'Maimakterion', 'Poseideon',
  'Gamelion', 'Anthesterion', 'Elaphebolion', 'Mounychion', 'Thargelion', 'Skirophorion',
];

/** Moon phase (0..1, 0 = new) on whole day d. */
export function moonPhaseOn(epoch: CalendarEpoch, d: number): number {
  const x = epoch.moonPhase0 + d / LUNATION_DAYS;
  return x - Math.floor(x);
}

/** True when whole day d starts a new lunation. */
function isNewMoon(epoch: CalendarEpoch, d: number): boolean {
  return Math.floor(epoch.moonPhase0 + d / LUNATION_DAYS) > Math.floor(epoch.moonPhase0 + (d - 1) / LUNATION_DAYS);
}

/** The solstice day that opens year k (year 0 is the year holding dayCount 0's solstice). */
function solsticeDay(epoch: CalendarEpoch, k: number): number {
  return SOLSTICE_DOY - epoch.doy0 + 365 * k;
}

/** First new-moon day at or after year k's solstice: 1 Hekatombaion. */
function yearStart(epoch: CalendarEpoch, k: number): number {
  const s = solsticeDay(epoch, k);
  for (let d = s; d < s + 31; d++) if (isNewMoon(epoch, d)) return d;
  throw new Error(`no new moon within 31 days of solstice ${s}`);
}

/** The year index k whose start (1 Hekatombaion) is the last one at or before d. */
function yearIndex(epoch: CalendarEpoch, d: number): number {
  let k = Math.floor((d - solsticeDay(epoch, 0)) / 365);
  while (yearStart(epoch, k) > d) k--;
  while (yearStart(epoch, k + 1) <= d) k++;
  return k;
}

/** The calendar date of whole day d. */
export function dateOn(epoch: CalendarEpoch, d: number): CalendarDate {
  const k = yearIndex(epoch, d);
  const ys = yearStart(epoch, k);
  const ye = yearStart(epoch, k + 1);
  const starts: number[] = [];
  for (let s = ys; s < ye; s++) if (isNewMoon(epoch, s)) starts.push(s);
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= d) i++;
  const leapYear = starts.length === 13;
  const names = leapYear ? [...MONTHS.slice(0, 6), 'Poseideon II', ...MONTHS.slice(6)] : MONTHS;
  return {
    year: k - yearIndex(epoch, 0) + 1,
    month: i,
    monthName: names[i],
    day: d - starts[i] + 1,
    monthLength: (starts[i + 1] ?? ye) - starts[i],
    intercalary: leapYear && i === 6,
  };
}

/** "13 Skirophorion · Year 1" */
export function formatDate(date: CalendarDate): string {
  return `${date.day} ${date.monthName} · Year ${date.year}`;
}

/** The first day after d that starts a new year (1 Hekatombaion). */
export function nextNewYearDay(epoch: CalendarEpoch, d: number): number {
  return yearStart(epoch, yearIndex(epoch, d) + 1);
}
