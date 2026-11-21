import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Three child processes, run one after another: under a full parallel run that
// takes longer than vitest's default 5 s.
test('offline selection selects exactly one included cell and rejects unknown names', { timeout: 30_000 }, () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/tone-probe.mjs', ...args], { encoding: 'utf8', env: { ...process.env, M365_TRANSPORT: '' } });
  const selected = run('--only=Gpt_56_Sol_Chat', '--included', '--dry-run');
  assert.equal(selected.status, 0, selected.stderr);
  const cells = JSON.parse(selected.stdout);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].tone, 'Gpt_56_Sol_Chat');
  assert.equal(cells[0].scenario, 'OfficeWebIncludedCopilot');
  assert.notEqual(run('--only=No_Such_Tone', '--included', '--dry-run').status, 0);
  assert.notEqual(run('--only=Gpt_56_Sol_Chat', '--dry-run').status, 0);
});
