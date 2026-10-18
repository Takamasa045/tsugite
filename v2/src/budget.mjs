import { fail } from './files.mjs';

// Fixed-point microcredits. No currency conversion or cross-service total.
export function units(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1e6)) || Math.abs(value * 1e6 - Math.round(value * 1e6)) > 1e-5) fail('Credits must be finite, nonnegative, with at most 6 decimal places');
  return Math.round(value * 1e6);
}
export function validateBudget(budget = {}) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) fail('Budget must map each service to its credits limit');
  for (const [service, amount] of Object.entries(budget)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) fail('Invalid budget service');
    units(amount);
  }
  return budget;
}
export function reserve(ledger, requests, budget) {
  validateBudget(budget);
  const next = structuredClone(ledger);
  for (const service of new Set(next.entries.map(x=>x.service))) {
    const used = next.entries.filter(x=>x.service===service).reduce((s,x)=>s+units(x.status==='settled'?x.actual:x.credits),0);
    if (used > units(Object.hasOwn(budget,service)?budget[service]:0)) fail('Budget is below committed credits for ' + service);
  }
  for (const request of requests) {
    const previous = next.entries.find(x => x.id === request.id);
    if (previous) {
      if (previous.service !== request.service || previous.credits !== request.credits) fail('Reservation identity changed');
      continue;
    }
    units(request.credits);
    if (request.credits > 0 && !Object.hasOwn(budget, request.service)) fail('No budget for service ' + request.service);
    const committed = next.entries.filter(x => x.service === request.service).reduce((sum, x) => sum + units(x.status === 'settled' ? x.actual : x.credits), 0);
    if (committed + units(request.credits) > units(Object.hasOwn(budget,request.service)?budget[request.service]:0)) fail('Budget exceeded for ' + request.service);
    next.entries.push({ ...request, status: 'reserved' });
  }
  return next;
}
export function settle(ledger, id, actual) {
  const entry = ledger.entries.find(x => x.id === id);
  if (!entry || entry.status !== 'started') fail('Reservation is not executing');
  if (units(actual) > units(entry.credits)) fail('Plugin exceeded reservation; reconcile uncertain outcome');
  entry.actual = actual;
  entry.status = 'settled';
}
export function budgetView(ledger) {
  return Object.fromEntries([...new Set(ledger.entries.map(x => x.service))].map(service => {
    const entries = ledger.entries.filter(x => x.service === service);
    return [service, { spent: entries.filter(x => x.status === 'settled').reduce((s, x) => s + units(x.actual), 0) / 1e6, reserved: entries.filter(x => x.status !== 'settled').reduce((s, x) => s + units(x.credits), 0) / 1e6 }];
  }));
}
