# DSH cursor runtime

Registers `cursor` with the `agentRuntime` Cordis service. Uses the existing Cursor SDK and local authentication. Native Cursor tools run in the requested workspace; this is separate from the DSH Cursor LLM bridge.

Supports creation, continuation, streaming and cancellation by exact run ID. Fork, Missions and plugin-level permission callbacks are unsupported. Usage is reported by the SDK.
