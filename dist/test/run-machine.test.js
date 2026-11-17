import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRunState, nextRunState, settleRunState } from '../lib/run.machine.js';
test('cursor runtime machine covers runs and reuse', () => {
    assert.equal(initialRunState(), 'idle');
    assert.equal(nextRunState('idle', 'START'), 'running');
    assert.equal(nextRunState('running', 'COMPLETE'), 'completed');
    assert.equal(nextRunState('completed', 'START'), 'running');
    assert.equal(nextRunState('running', 'CANCEL'), 'cancelled');
    assert.equal(nextRunState('cancelled', 'START'), 'running');
    assert.equal(nextRunState('failed', 'CLOSE'), 'closing');
    assert.equal(nextRunState('closing', 'CLOSED'), 'closed');
    assert.equal(settleRunState('completed', 'FAIL'), 'completed');
    assert.throws(() => nextRunState('closed', 'START'), /illegal cursor runtime transition/);
});
