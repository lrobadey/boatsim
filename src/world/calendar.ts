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

/** Moon phase (0..1, 0 = new) on whole day d. */
export function moonPhaseOn(epoch: CalendarEpoch, d: number): number {
  void epoch;
  void d;
  throw new Error('not implemented');
}

/** The calendar date of whole day d. */
export function dateOn(epoch: CalendarEpoch, d: number): CalendarDate {
  void epoch;
  void d;
  throw new Error('not implemented');
}

/** "13 Skirophorion · Year 1" */
export function formatDate(date: CalendarDate): string {
  void date;
  throw new Error('not implemented');
}

/** The first day after d that starts a new year (1 Hekatombaion). */
export function nextNewYearDay(epoch: CalendarEpoch, d: number): number {
  void epoch;
  void d;
  throw new Error('not implemented');
}
