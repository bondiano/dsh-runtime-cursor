/** Session/run lifecycle of the Cursor SDK adapter (index.js). */
import { createMachine, initialTransition, transition } from 'xstate';
export const cursorRuntimeMachine = createMachine({
    id: 'cursorRuntimeSession',
    initial: 'idle',
    states: {
        idle: { on: { START: 'running', CLOSE: 'closing' } },
        running: { on: { COMPLETE: 'completed', CANCEL: 'cancelled', FAIL: 'failed', CLOSE: 'closing' } },
        completed: { on: { START: 'running', CLOSE: 'closing' } },
        cancelled: { on: { START: 'running', CLOSE: 'closing' } },
        failed: { on: { START: 'running', CLOSE: 'closing' } },
        closing: { on: { CLOSED: 'closed' } },
        closed: { type: 'final' },
    },
});
export const initialRunState = () => initialTransition(cursorRuntimeMachine)[0].value;
export function nextRunState(state, event) {
    const eventObject = typeof event === 'string' ? { type: event } : event;
    const snapshot = cursorRuntimeMachine.resolveState({ value: state });
    if (!snapshot.can(eventObject))
        throw new Error(`illegal cursor runtime transition: ${state} --${eventObject.type}-->`);
    return transition(cursorRuntimeMachine, snapshot, eventObject)[0].value;
}
export function settleRunState(state, event) {
    return state === 'running' ? nextRunState(state, event) : state;
}
