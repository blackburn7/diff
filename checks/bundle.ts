// Bundle gate: the app, the highlighter worker, and the stylesheet, raw and
// gzipped, against checks/budget.json. Same ratchet as the perf gate: shrink,
// don't raise. `--ratchet` lowers budgets that have room.
import { gzipSync } from 'node:zlib';
import { buildClient } from '../src/build.ts';
import { BUDGET_FILE, ratchet, readBudget, report, writeBudget, type Metrics } from './budget.ts';

const c = await buildClient();
const measured: Metrics = {};
for (const [name, text] of [['app.js', c.js], ['hl-worker.js', c.worker], ['style.css', c.css]] as const) {
  measured[`${name} bytes`] = Buffer.byteLength(text);
  measured[`${name} gzip bytes`] = gzipSync(text).length;
}

const budget = readBudget();
const failures = report('bundle', measured, budget.bundle);
if (process.argv.includes('--ratchet')) {
  budget.bundle = ratchet(measured, budget.bundle);
  writeBudget(budget);
  console.log(`ratcheted ${BUDGET_FILE}`);
} else if (failures) {
  console.error(`\nbundle budget: ${failures} failure(s) — shrink, don't raise the budget`);
  process.exit(1);
}
