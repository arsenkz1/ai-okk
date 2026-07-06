const test = require('node:test');
const assert = require('node:assert/strict');

const { runStartupChecks } = require('../dist/startup');

test('runs amoCRM webhook check once on service startup', async () => {
  const events = [];
  const notifyAdmins = async (text) => events.push(['notify', text]);

  await runStartupChecks({
    applyPilotDisciplineManagerConfig: async () => events.push(['pilot']),
    checkAndRestoreAmoCrmWebhook: async (notifyFn) => {
      events.push(['amo-check', notifyFn === notifyAdmins]);
    },
    notifyAdmins,
    logger: { log() {}, error() {} },
  });

  assert.deepEqual(events, [
    ['pilot'],
    ['amo-check', true],
  ]);
});

test('logs amoCRM startup check failures without rejecting startup checks', async () => {
  const errors = [];

  await assert.doesNotReject(() => runStartupChecks({
    applyPilotDisciplineManagerConfig: async () => undefined,
    checkAndRestoreAmoCrmWebhook: async () => {
      throw new Error('amo unavailable');
    },
    notifyAdmins: async () => undefined,
    logger: { log() {}, error: (...args) => errors.push(args.join(' ')) },
  }));

  assert.equal(errors.some((line) => line.includes('Failed to check amoCRM webhook at startup')), true);
});
