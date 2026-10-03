/**
 * Responsibility: Verify quiet hours, throttling and live configuration for proactive reminders.
 * Implementation: 1. Inject clock values and callbacks. 2. Assert each suppression rule. 3. Keep the service timer-free in tests.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProactiveService } = require('../proactive-service');

test('proactive service respects quiet hours, enablement and interval', () => {
  const emitted = [];
  let enabled = true; let interval = 60;
  const service = new ProactiveService({ getIntervalMinutes: () => interval, isEnabled: () => enabled, emit: value => emitted.push(value) });
  const morning = new Date('2026-10-04T10:00:00+08:00').getTime();
  assert.equal(service.tick(morning), true);
  assert.equal(emitted.length, 1);
  assert.equal(service.tick(morning + 30 * 60000), false);
  interval = 30;
  assert.equal(service.tick(morning + 31 * 60000), true);
  enabled = false;
  assert.equal(service.tick(morning + 62 * 60000), false);
  assert.equal(service.tick(new Date('2026-10-04T23:30:00+08:00').getTime()), false);
});
