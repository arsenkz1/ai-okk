/**
 * The sales manager's weekly pay, exactly as the payroll spreadsheet computes
 * it (sheet "октябрь 2026", МОПЫ block):
 *
 *   plan ratio      = round(fact / plan, 2)
 *   shift cost      = rate / 26 × coefficient(ratio)   60% <30%, 75% <50%, 85% <70%, else 100%
 *   base salary     = shift cost × worked days
 *   bonus           = fact × bonusRate(ratio)          0 <30%, 1% <70%, 2% <80%, 3% <90%, 4% <100%, 5% <120%, else 6%
 *   total           = round(base + bonus, to thousands)
 *
 * Manual bonuses and penalties from the sheet are not part of this; the
 * result is a preliminary figure. Team leads and ROPs are paid by other
 * rules and are out of scope.
 */

export const SHIFTS_PER_MONTH = 26;

export interface SalaryInput {
  /** Monthly fixed rate, UZS. */
  fixedMonthlyRate: number;
  workedDays: number;
  /** Plan for the period, UZS. */
  plan: number;
  /** Sales fact for the period, UZS. */
  fact: number;
}

export interface SalaryResult {
  planRatio: number;
  shiftCoefficient: number;
  shiftCost: number;
  baseSalary: number;
  bonusRate: number;
  bonus: number;
  total: number;
}

export function planRatio(fact: number, plan: number): number {
  if (!(plan > 0) || !(fact >= 0)) return 0;
  return Math.round((fact / plan) * 100) / 100;
}

export function shiftCoefficient(ratio: number): number {
  if (ratio < 0.3) return 0.6;
  if (ratio < 0.5) return 0.75;
  if (ratio < 0.7) return 0.85;
  return 1;
}

export function bonusRate(ratio: number): number {
  if (ratio < 0.3) return 0;
  if (ratio < 0.7) return 0.01;
  if (ratio < 0.8) return 0.02;
  if (ratio < 0.9) return 0.03;
  if (ratio < 1) return 0.04;
  if (ratio < 1.2) return 0.05;
  return 0.06;
}

export function calculateSalary(input: SalaryInput): SalaryResult {
  const ratio = planRatio(input.fact, input.plan);
  const coefficient = shiftCoefficient(ratio);
  const shiftCost = (input.fixedMonthlyRate / SHIFTS_PER_MONTH) * coefficient;
  const baseSalary = shiftCost * input.workedDays;
  const rate = bonusRate(ratio);
  const bonus = input.fact * rate;
  return {
    planRatio: ratio,
    shiftCoefficient: coefficient,
    shiftCost,
    baseSalary,
    bonusRate: rate,
    bonus,
    total: Math.round((baseSalary + bonus) / 1000) * 1000,
  };
}
