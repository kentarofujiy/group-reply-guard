# Group Reply Guard

This extension post-processes character replies in SillyTavern group chats to keep a generated message aligned with the character who was actually drafted to speak.

Its main job is to catch two common failure modes:

1. A drafted character reply includes text that belongs to the user or another group member.
2. A generated reply is technically attributed to the drafted character, but still contains low-quality meta text, repetition, or omniscient narration that should be cleaned up or rewritten.

The implementation is intentionally split into a deterministic guard layer and an optional LLM repair layer. That split matters if you want to extend it safely.

## Installation

1. Copy or clone this repository into your SillyTavern `public/scripts/extensions/third-party/` directory as `group-reply-guard`.
2. Reload SillyTavern and open **Extensions**.
3. Enable **Group Reply Guard** in the extensions drawer.

## Quick usage

1. Start or open a **group chat**.
2. Ensure **Enable group reply guarding** is checked in the extension settings.
3. Generate replies as usual; Group Reply Guard will process incoming character messages automatically.
4. Optionally click the shield button on a character message to run manual Analyze/Re-analyze.

## File map

- `index.js`: main runtime, settings UI wiring, event listeners, LLM prompt construction, message mutation, rerouting, diagnostics.
- `guard-utils.js`: pure text-analysis helpers for attribution cleanup, speaker detection, quality heuristics, and normalization.
- `settings.html`: settings drawer rendered into the stock extensions settings container.
- `style.css`: settings and diagnostics styling, plus the manual message action button state.
- `manifest.json`: SillyTavern extension manifest.

## Runtime model

The extension is event-driven and only acts in group chats.

### Custom integration event

The extension emits a custom event after guard finalization completes:

```js
'group_reply_guard:post_guard'
```

This event fires only after `finalizePendingMessageUpdate(...)` finishes its work for a processed message. That means listeners can treat it as the point where Group Reply Guard is done with that message for the current pass.

Guarantees at emission time:

- the message block has been rerendered if Group Reply Guard changed the visible text
- rerouted segments have already been dispatched if current settings allowed dispatch
- `saveChat()` has already completed
- the extension's pending finalization state for that message has already been cleared

Deliberate non-guarantee:

- preview-only manual analysis does not emit this event, because it never enters the finalization path under the current design

Recommended listener shape:

```js
eventSource.on('group_reply_guard:post_guard', payload => {
  console.log(payload.messageId, payload.expectedSpeaker, payload.finalText);
});
```

### Event lifecycle

At startup, `index.js`:

- initializes default settings under `extension_settings.groupReplyGuard`
- renders the settings UI with `renderExtensionTemplateAsync(...)`
- binds a delegated click handler for the per-message shield action
- subscribes to several SillyTavern events

The important event sequence is:

1. `GROUP_WRAPPER_STARTED`
2. `GROUP_MEMBER_DRAFTED`
3. `MESSAGE_RECEIVED`
4. `CHARACTER_MESSAGE_RENDERED`
5. `GROUP_WRAPPER_FINISHED`

The extension uses that sequence like this:

- `GROUP_MEMBER_DRAFTED` stores the drafted character id in `runtimeState.expectedCharacterId`.
- `MESSAGE_RECEIVED` runs the guard pipeline before the message is finalized in the UI.
- `CHARACTER_MESSAGE_RENDERED` applies deferred updates, rerenders the message block if needed, and optionally dispatches rerouted segments with `/sendas`.
- `CHAT_CHANGED` resets all transient runtime state.
- `GROUP_WRAPPER_FINISHED` clears the drafted-speaker marker.

`eventSource.makeFirst(event_types.MESSAGE_RECEIVED, handleMessageReceived)` is important: the extension asks to run before other ordinary `MESSAGE_RECEIVED` listeners. If you add another extension that also mutates fresh messages, ordering will matter.

## Internal state

The extension keeps all transient state in `runtimeState`:

- `expectedCharacterId`: the last drafted character id from `GROUP_MEMBER_DRAFTED`
- `pendingByMessageId`: deferred per-message updates waiting for render completion
- `suppressNextMessages`: counter used to ignore messages the extension itself creates via `/sendas`
- `diagnostics`: recent debug entries shown in settings
- `participantProfiles`: cached profile summaries for current group participants

Nothing in `runtimeState` is persisted across chat changes. Persisted configuration lives only in `extension_settings.groupReplyGuard`.

## Settings contract

Current settings shape:

```js
{
  settingsVersion: 4,
  enabled: true,
  autoRewrite: true,
  autoAnalyzeAmbiguous: true,
  rewriteAllReplies: false,
  reroutePolicy: 'disabled',
  manualMessageActions: true,
  manualAnalysisCanMutate: true,
  debug: true,
  contextWindow: 8,
  analysisResponseLength: 260,
  rewriteResponseLength: 220,
  diagnosticsLimit: 12,
  userAliases: '',
  analysisSystemPrompt: '...',
  rewriteSystemPrompt: '...'
}
```

Notes:

- `getSettings()` is the migration point. If you add or rename a setting, update both `DEFAULT_SETTINGS` and the version-upgrade branch there.
- Both the analysis and rewrite system prompts are user-configurable.
- `reroutePolicy` controls when leaked other-character segments are re-sent: `disabled`, `manual-only`, or `always`.
- The settings UI is handwritten in `settings.html` and bound manually in `initializeSettingsUi()`.

## Message-processing pipeline

The core pipeline lives in `processMessage(messageId, options)`.

### 1. Early exit and target resolution

The extension skips processing when any of these are true:

- extension disabled
- not a group chat
- message is missing, user-authored, or system-authored
- message already marked as processed
- the message was just created by the extension itself through rerouting

Expected speaker resolution is:

1. drafted character, when `preferDrafted` is enabled
2. character matched from `message.name`
3. fallback to drafted character again

That fallback makes manual re-analysis more forgiving when the drafted speaker is no longer available.

### 2. Deterministic cleanup

`sanitizeGeneratedReply(...)` from `guard-utils.js` is the first pass.

It performs line-based cleanup with no model call:

- normalizes whitespace and blank lines
- detects explicit speaker prefixes like `Alice:` or action-style prefixes
- keeps lines for the expected speaker
- removes user lines entirely
- removes other-character lines and stores them as `reroutedSegments`
- flags quality problems such as repetition, meta responses, and omniscient narration

This deterministic pass returns:

```js
{
  cleanText,
  reroutedSegments,
  issues,
  modified
}
```

If you want to add cheap, reliable detection, this is the safest place to do it.

### 3. Ambiguity detection

`detectAttributionSignals(...)` looks for less explicit attribution problems, such as user references or other-character references embedded in prose.

Those signals do not directly rewrite the message. They are used to decide whether the extension should escalate to the LLM analysis pass.

Important routing rule: a bare mention of another participant's name is not enough to reroute text. The extension now requires stronger evidence such as an explicit speaker label or a clear prose cue that the other participant owns that segment.

### 4. Optional LLM analysis

If `shouldAnalyzeWithLlm(...)` returns true, the extension calls `analyzeReplyWithLlm(...)`.

The analysis prompt includes:

- expected speaker name
- configured user aliases
- other group participants
- expected speaker profile fields
- recent chat context
- participant summaries
- deterministic issues already found
- the raw candidate reply

The preferred response path uses `context.generateRaw(...)` with a JSON schema. If schema-constrained generation fails, the extension retries with a plain JSON-only prompt and then extracts the first JSON object from the model output.

Normalized LLM analysis output must look like:

```js
{
  cleanText: string,
  confidence: 'low' | 'medium' | 'high',
  rewriteNeeded: boolean,
  issues: string[],
  reroutedSegments: [{ speaker, text }]
}
```

The result is sanitized again through `sanitizeGeneratedReply(...)` before being trusted.

That second sanitization is deliberate. It treats model output as untrusted text.

Model-produced reroutes are also filtered against the original message. If the only evidence is a quoted or narrative mention of another participant by name, the reroute is rejected and the text stays with the expected speaker.

### 5. Optional rewrite pass

If `shouldRewriteReply(...)` decides the reply still needs repair, `rewriteReply(...)` performs a second model call.

The rewrite prompt is more style-oriented than the analysis prompt. It asks the model to produce the final in-character message only, with no explanation.

Triggers for rewrite are controlled by `REWRITE_TRIGGER_ISSUES`:

- `empty_after_cleanup`
- `nonsensical_repetition`
- `repetition_detected`
- `omniscient_or_meta_content`
- `meta_rewrite_response`
- `llm_rewrite_recommended`

If the model answers with analysis or meta commentary instead of the reply, the extension retries once with a stricter follow-up instruction.

### 6. Mutation, metadata, and deferred finalization

After all passes:

- `message.mes` is updated if mutation is allowed and the final text changed
- `message.extra.group-reply-guard` metadata is written
- rerouted segments are stored in `pendingByMessageId`
- a diagnostic entry is added with both the original and processed text snippets for comparison

The actual chat save and optional `/sendas` dispatch happen later in `finalizePendingMessageUpdate(...)`, which runs on `CHARACTER_MESSAGE_RENDERED`.

That deferred step is important because the extension wants the message element to exist before forcing a rerender.

After finalization completes, the extension emits `group_reply_guard:post_guard` with a stable payload for downstream integrations.

## Message metadata contract

Each processed message receives an `extra` payload under the module name:

```js
message.extra['group-reply-guard'] = {
  processed: true,
  expectedSpeaker,
  issues,
  rewriteApplied,
  llmAnalysisUsed,
  lastSource,
  lastPreview,
  processedAt
}
```

Meanings:

- `processed`: prevents auto-processing the same message twice
- `expectedSpeaker`: final speaker the extension used for guard logic
- `issues`: accumulated issue labels from all passes
- `rewriteApplied`: true when the rewrite pass changed the text
- `llmAnalysisUsed`: true when the analysis pass ran successfully
- `lastSource`: `auto` or `manual`
- `lastPreview`: preview text only when manual analysis runs in preview mode
- `processedAt`: unix timestamp in milliseconds

If another extension wants to build on this one, this `message.extra` payload is the safest integration point.

For active runtime integrations, prefer the custom `group_reply_guard:post_guard` event over polling `message.extra`, because it gives you a clear lifecycle boundary.

## Diagnostics view

When debug mode is enabled, each diagnostics entry now shows a compact before/after comparison:

- `original`: the normalized message text captured before guard processing
- `processed`: the final text preview after cleanup, optional analysis, and optional rewrite

Both sections are collapsible. The closed state shows a compact snippet, and expanding the section reveals the full captured text for that side of the comparison.

This is intentionally limited to local diagnostics snippets rather than full prompt/response logging. The extension does not log full analysis or rewrite requests and responses by default, because those payloads include recent chat context and profile data and are much noisier for day-to-day debugging.

## Post-guard event payload

The post-guard event payload has this shape:

```js
{
  messageId,
  source,
  expectedSpeaker,
  finalText,
  changed,
  issues,
  llmAnalysisUsed,
  rewriteApplied,
  reroutedSegments,
  rerouteDispatched,
  processedAt
}
```

Field meanings:

- `messageId`: numeric chat message id
- `source`: `auto` or `manual`
- `expectedSpeaker`: speaker used for the guard pass
- `finalText`: final guarded message text after mutation and cleanup
- `changed`: whether the message text was changed by the pass
- `issues`: accumulated issue labels from the guard pipeline
- `llmAnalysisUsed`: whether the LLM attribution analysis pass ran successfully
- `rewriteApplied`: whether the rewrite pass changed the text
- `reroutedSegments`: normalized leaked segments assigned to other speakers
- `rerouteDispatched`: whether those rerouted segments were actually emitted via `/sendas`
- `processedAt`: timestamp copied from the message metadata written during processing

## Manual action flow

The extension injects a shield button into each character message when `manualMessageActions` is enabled.

Manual re-analysis differs from automatic processing in two ways:

- it bypasses the `processed` guard so an already-processed message can be analyzed again
- it forces the LLM analysis path even if deterministic ambiguity signals are weak

When `manualAnalysisCanMutate` is false, manual analysis still writes metadata and diagnostics but leaves `message.mes` unchanged.

## Rerouting behavior

When the deterministic or LLM pass identifies text that belongs to another group member, the extension stores it as `reroutedSegments`.

If the current `reroutePolicy` allows dispatch for the current source, each rerouted segment is emitted as:

```text
/sendas name="Speaker Name" "segment text"
```

Policy behavior:

- `disabled`: rerouted segments are detected and recorded, but never sent
- `manual-only`: rerouted segments are sent only for manual re-analysis actions
- `always`: rerouted segments are sent for both automatic and manual runs

Before dispatch, `runtimeState.suppressNextMessages` is incremented so the extension does not immediately re-process its own synthetic messages.

This logic assumes the rerouted text is safe to emit as a separate chat message. If you want finer control, `dispatchReroutedSegments(...)` is the place to extend.

## Heuristics in `guard-utils.js`

`guard-utils.js` is the extension's pure logic layer.

Key helpers:

- `normalizeReplyText(text)`: trims, normalizes line endings, collapses blank-line runs
- `detectExplicitSpeaker(line, names)`: detects explicit `Name:` or action-style speaker prefixes
- `stripSpeakerPrefix(line, speakerName)`: removes the detected prefix while preserving formatting as much as possible
- `detectQualityIssues(text)`: flags repetition, meta responses, and omniscient narration
- `detectAttributionSignals({ ... })`: flags ambiguous references that may require LLM analysis
- `sanitizeGeneratedReply({ ... })`: main deterministic cleanup pass

Constants worth understanding:

- `QUALITY_MARKERS`: regexes for omniscient or out-of-character prose
- `META_RESPONSE_MARKERS`: regexes for model outputs that explain the task instead of producing a reply
- `ATTRIBUTION_REFERENCE_MARKERS`: broad signals that multi-character prose may be present

If you add new issue labels, keep them stable. They feed multiple downstream decisions, including rewrite triggers and diagnostics.

## Safe extension points

### Add a new deterministic detector

Preferred location: `guard-utils.js`

Why:

- fastest path
- easiest to test
- no extra model call cost
- lower risk than changing prompt behavior

Examples:

- stricter speaker-prefix parsing
- markdown quote stripping rules
- richer repetition or hallucination checks

### Add a new rewrite trigger

Preferred location: `REWRITE_TRIGGER_ISSUES` in `index.js`

Use this when a new issue label should escalate to the rewrite pass.

### Add a new setting

Required touch points:

1. `DEFAULT_SETTINGS`
2. `SETTINGS_VERSION` and migration logic in `getSettings()` if needed
3. `settings.html`
4. `loadSettingsIntoDom()`
5. `initializeSettingsUi()`

### Change rerouting strategy

Preferred location: `dispatchReroutedSegments(...)`

Possible directions:

- batch multiple rerouted segments per speaker
- convert rerouted content into a diagnostic-only preview
- add a confidence threshold before sending

### Change what the LLM sees

Preferred locations:

- `buildParticipantsSummary(...)`
- `getRecentContext(...)`
- `rewriteReply(...)`
- `analyzeReplyWithLlm(...)`

Keep the deterministic guard in place even if you improve prompts. The current design depends on treating model outputs as unreliable until sanitized.

## Limitations and design assumptions

- The extension is scoped to group chats only.
- Speaker matching is name-based after draft resolution. If names collide, attribution can become ambiguous.
- Only explicit speaker prefixes are deterministically rerouted. Ambiguous prose still needs LLM help.
- Analysis and rewrite system prompts are user-editable in settings, so prompt quality can vary between installs.
- Diagnostics are in-memory only and cleared on chat change.
- Message mutation and rerouting are separate phases, which means downstream extensions listening after render may observe already-mutated text but not yet-dispatched reroutes.

## Suggested improvement areas

If you plan to extend this extension, these are the highest-value next steps:

1. Add focused tests for `guard-utils.js`, especially `sanitizeGeneratedReply(...)`, because it carries most of the safety-critical logic.
2. Move issue labels to a central enum-like object to reduce typo risk.
3. Expose rewrite-trigger controls in settings for finer auto-rewrite tuning.
4. Record confidence or provenance on rerouted segments so `/sendas` can be gated more conservatively.
5. Add more lifecycle hooks around analysis/rewrite phases so integrations can subscribe beyond the existing post-guard event.

## Practical rule for future changes

If a new idea can be solved deterministically in `guard-utils.js`, do that first.

Use the LLM path only for genuinely ambiguous attribution or voice repair. That keeps the extension cheaper, more predictable, and easier to debug.
