// @ts-nocheck
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';

import { createPostGuardEventPayload, GROUP_REPLY_GUARD_POST_GUARD_EVENT } from './event-contract.js';
import { detectAttributionSignals, detectQualityIssues, hasSpeakerReferenceEvidence, normalizeReplyText, sanitizeGeneratedReply, truncateText } from './guard-utils.js';

const MODULE_NAME = 'group-reply-guard';
const TEMPLATE_MODULE = 'third-party/group-reply-guard';
const SETTINGS_KEY = 'groupReplyGuard';
const SETTINGS_VERSION = 4;
const REROUTE_POLICIES = {
    DISABLED: 'disabled',
    MANUAL_ONLY: 'manual-only',
    ALWAYS: 'always',
};
const DEFAULT_REWRITE_SYSTEM_PROMPT = [
    'You are repairing a SillyTavern group-chat reply.',
    'Return only the corrected final message text.',
    'Never explain your work, never analyze the task, and never mention the user, candidate reply, issues, participants, or context labels.',
    'Only the expected speaker may act, think, narrate, or speak.',
    'Remove or rewrite any user content, other-character content, omniscient narration, repetition, and nonsense.',
    'Match the expected speaker\'s tone, vocabulary, and mannerisms using the supplied profile and examples.',
    'Keep the reply grounded in the recent chat context.',
    'Do not add speaker labels unless the candidate reply already depends on them for formatting.',
    'If the candidate reply is already valid, return it rewritten minimally in the same voice rather than describing it.',
].join(' ');

const DEFAULT_ANALYSIS_SYSTEM_PROMPT = [
    'You audit and repair a SillyTavern group-chat reply.',
    'Return only structured data that matches the requested schema.',
    'Identify whether the candidate reply contains narration, dialogue, or actions that belong to speakers other than the expected character.',
    'If repair is needed, cleanText must contain only the final text that should remain on the expected character message.',
    'If a segment clearly belongs to another participant, place it in reroutedSegments with the correct speaker name and text.',
    'Do not reroute a segment merely because another participant is mentioned by name inside the expected speaker\'s dialogue or narration.',
    'Quoted content like "Sofia is dressing like a disco angel" stays with the expected speaker unless the text explicitly attributes that quote or action to Sofia.',
    'A line such as "Not this time," Bob replied belongs to Bob even though Bob\'s name is outside the quote.',
    'Never write analysis prose outside the JSON object.',
].join(' ');

const ANALYSIS_RESPONSE_SCHEMA = {
    $schema: 'http://json-schema.org/draft-04/schema#',
    type: 'object',
    properties: {
        cleanText: { type: 'string' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        rewriteNeeded: { type: 'boolean' },
        issues: {
            type: 'array',
            items: { type: 'string' },
        },
        reroutedSegments: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    speaker: { type: 'string' },
                    text: { type: 'string' },
                },
                required: ['speaker', 'text'],
                additionalProperties: false,
            },
        },
    },
    required: ['cleanText', 'confidence', 'rewriteNeeded', 'issues', 'reroutedSegments'],
    additionalProperties: false,
};

const REWRITE_TRIGGER_ISSUES = new Set([
    'empty_after_cleanup',
    'nonsensical_repetition',
    'repetition_detected',
    'omniscient_or_meta_content',
    'meta_rewrite_response',
    'llm_rewrite_recommended',
]);

const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    enabled: true,
    autoRewrite: true,
    autoAnalyzeAmbiguous: true,
    rewriteAllReplies: false,
    reroutePolicy: REROUTE_POLICIES.DISABLED,
    manualMessageActions: true,
    manualAnalysisCanMutate: true,
    debug: true,
    contextWindow: 8,
    analysisResponseLength: 260,
    rewriteResponseLength: 220,
    diagnosticsLimit: 12,
    userAliases: '',
    analysisSystemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
    rewriteSystemPrompt: DEFAULT_REWRITE_SYSTEM_PROMPT,
};

const runtimeState = {
    expectedCharacterId: null,
    pendingByMessageId: new Map(),
    suppressNextMessages: 0,
    diagnostics: [],
    participantProfiles: new Map(),
};

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }

    if (extension_settings[SETTINGS_KEY].settingsVersion !== SETTINGS_VERSION) {
        const legacyReroutePolicy = extension_settings[SETTINGS_KEY].allowSendAsOther
            ? REROUTE_POLICIES.ALWAYS
            : REROUTE_POLICIES.DISABLED;

        extension_settings[SETTINGS_KEY] = Object.assign({}, extension_settings[SETTINGS_KEY], {
            settingsVersion: SETTINGS_VERSION,
            rewriteAllReplies: false,
            autoAnalyzeAmbiguous: true,
            manualMessageActions: true,
            manualAnalysisCanMutate: true,
            reroutePolicy: extension_settings[SETTINGS_KEY].reroutePolicy ?? legacyReroutePolicy,
            analysisSystemPrompt: extension_settings[SETTINGS_KEY].analysisSystemPrompt ?? DEFAULT_ANALYSIS_SYSTEM_PROMPT,
        });

        delete extension_settings[SETTINGS_KEY].allowSendAsOther;
    }

    extension_settings[SETTINGS_KEY] = Object.assign({}, DEFAULT_SETTINGS, extension_settings[SETTINGS_KEY]);

    if (!Object.values(REROUTE_POLICIES).includes(extension_settings[SETTINGS_KEY].reroutePolicy)) {
        extension_settings[SETTINGS_KEY].reroutePolicy = DEFAULT_SETTINGS.reroutePolicy;
    }

    extension_settings[SETTINGS_KEY].analysisSystemPrompt = String(
        extension_settings[SETTINGS_KEY].analysisSystemPrompt ?? DEFAULT_ANALYSIS_SYSTEM_PROMPT,
    ).trim() || DEFAULT_ANALYSIS_SYSTEM_PROMPT;

    return extension_settings[SETTINGS_KEY];
}

function shouldDispatchReroutedSegments(source) {
    const { reroutePolicy } = getSettings();

    if (reroutePolicy === REROUTE_POLICIES.ALWAYS) {
        return true;
    }

    if (reroutePolicy === REROUTE_POLICIES.MANUAL_ONLY) {
        return source === 'manual';
    }

    return false;
}

function resetRuntimeState() {
    runtimeState.expectedCharacterId = null;
    runtimeState.pendingByMessageId.clear();
    runtimeState.participantProfiles.clear();
    setStatus('Idle');
    setExpectedSpeakerLabel('No drafted speaker');
}

function setStatus(text) {
    const element = document.getElementById('group_reply_guard_status');
    if (element) {
        element.textContent = text;
    }
}

function setExpectedSpeakerLabel(text) {
    const element = document.getElementById('group_reply_guard_expected_speaker');
    if (element) {
        element.textContent = text;
    }
}

function addDiagnostic(entry) {
    const settings = getSettings();
    if (!settings.debug) {
        return;
    }

    runtimeState.diagnostics.unshift(entry);
    runtimeState.diagnostics = runtimeState.diagnostics.slice(0, settings.diagnosticsLimit);
    renderDiagnostics();
}

function createDiagnosticTextSection(label, previewText, fullText, extraClass = '') {
    const section = document.createElement('details');
    section.className = `group-reply-guard-entry-section ${extraClass}`.trim();

    const summary = document.createElement('summary');
    summary.className = 'group-reply-guard-entry-summary';

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'group-reply-guard-entry-label';
    sectionLabel.textContent = label;

    const preview = document.createElement('code');
    preview.className = 'group-reply-guard-entry-summary-text';
    preview.textContent = previewText;

    summary.append(sectionLabel, preview);

    const full = document.createElement('code');
    full.className = 'group-reply-guard-entry-full-text';
    full.textContent = fullText;

    section.append(summary, full);
    return section;
}

function renderDiagnostics() {
    const container = document.getElementById('group_reply_guard_diagnostics');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    if (!getSettings().debug) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = '';

    for (const entry of runtimeState.diagnostics) {
        const element = document.createElement('div');
        element.className = 'group-reply-guard-entry';

        const issues = entry.issues.length ? entry.issues.join(', ') : 'none';
        const rerouted = entry.rerouted.length ? ` | rerouted: ${entry.rerouted.join(', ')}` : '';

        const header = document.createElement('div');
        header.className = 'group-reply-guard-entry-header';

        const speaker = document.createElement('span');
        speaker.textContent = `${entry.speaker} · ${entry.source}${entry.llmAnalysisUsed ? ' + llm' : ''}${entry.mutated ? ' · applied' : ' · preview'}`;
        header.append(speaker);

        const timestamp = document.createElement('span');
        timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
        header.append(timestamp);

        const issuesElement = document.createElement('div');
        issuesElement.className = 'group-reply-guard-entry-issues';
        issuesElement.textContent = `issues: ${issues}${rerouted}`;

        const comparison = document.createElement('div');
        comparison.className = 'group-reply-guard-entry-comparison';

        const originalSection = createDiagnosticTextSection(
            'original',
            entry.originalPreview,
            entry.originalText,
            'group-reply-guard-entry-original',
        );
        const processedSection = createDiagnosticTextSection(
            'processed',
            entry.preview,
            entry.fullText,
        );

        comparison.append(originalSection, processedSection);

        element.append(header, issuesElement, comparison);

        container.append(element);
    }
}

function getGroup(context) {
    if (!context.groupId) {
        return null;
    }

    return context.groups.find(group => String(group.id) === String(context.groupId)) ?? null;
}

function getExpectedCharacter(context) {
    if (typeof runtimeState.expectedCharacterId !== 'number') {
        return null;
    }

    return context.characters[runtimeState.expectedCharacterId] ?? null;
}

function findCharacterByName(context, name) {
    const expectedName = String(name ?? '').trim().toLowerCase();
    if (!expectedName) {
        return null;
    }

    for (const profile of runtimeState.participantProfiles.values()) {
        if (profile.name.toLowerCase() === expectedName) {
            return context.characters[profile.characterId] ?? null;
        }
    }

    return context.characters.find(character => String(character?.name ?? '').trim().toLowerCase() === expectedName) ?? null;
}

function resolveExpectedCharacter(context, message, { preferDrafted = false } = {}) {
    if (preferDrafted) {
        const draftedCharacter = getExpectedCharacter(context);
        if (draftedCharacter) {
            return draftedCharacter;
        }
    }

    const messageCharacter = findCharacterByName(context, message?.name);
    if (messageCharacter) {
        return messageCharacter;
    }

    return getExpectedCharacter(context);
}

function summarizeCharacterField(value, maxLength = 420) {
    return truncateText(String(value ?? '').replace(/\s+/g, ' '), maxLength);
}

function buildCharacterProfile(context, characterId) {
    const character = context.characters[characterId];
    if (!character) {
        return null;
    }

    const fields = context.getCharacterCardFields({ chid: characterId });

    return {
        characterId,
        name: character.name,
        description: summarizeCharacterField(fields.description),
        personality: summarizeCharacterField(fields.personality),
        scenario: summarizeCharacterField(fields.scenario),
        mesExamples: summarizeCharacterField(fields.mesExamples, 640),
        firstMessage: summarizeCharacterField(fields.firstMessage, 320),
    };
}

function refreshParticipantProfiles(context) {
    runtimeState.participantProfiles.clear();
    const group = getGroup(context);

    if (!group) {
        return;
    }

    for (const avatar of group.members) {
        const characterId = context.characters.findIndex(character => character.avatar === avatar);
        if (characterId === -1) {
            continue;
        }

        const profile = buildCharacterProfile(context, characterId);
        if (profile) {
            runtimeState.participantProfiles.set(profile.name, profile);
        }
    }
}

function getUserNames(context) {
    const settings = getSettings();
    const configuredAliases = String(settings.userAliases ?? '')
        .split(/[\n,]/)
        .map(value => value.trim())
        .filter(Boolean);

    return Array.from(new Set([
        context.name1,
        'You',
        'User',
        ...configuredAliases,
    ].filter(Boolean)));
}

function getRecentContext(context, messageId) {
    const settings = getSettings();
    const startIndex = Math.max(0, Number(messageId) - settings.contextWindow);
    return context.chat
        .slice(startIndex, Number(messageId))
        .filter(message => message && !message.is_system)
        .map(message => `${message.name}: ${truncateText(message.mes, 220)}`)
        .join('\n');
}

function buildParticipantsSummary(expectedName) {
    return Array.from(runtimeState.participantProfiles.values())
        .map(profile => {
            const relation = profile.name === expectedName ? 'expected speaker' : 'other participant';
            return [
                `${profile.name} (${relation})`,
                profile.description && `description: ${profile.description}`,
                profile.personality && `personality: ${profile.personality}`,
                profile.mesExamples && `examples: ${profile.mesExamples}`,
            ].filter(Boolean).join('\n');
        })
        .join('\n\n');
}

function getMessageElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${Number(messageId)}"]`);
}

function isCharacterMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

function showToast(level, message) {
    if (globalThis.toastr?.[level]) {
        globalThis.toastr[level](message, 'Group Reply Guard');
    }
}

function uniqueIssues(values) {
    return Array.from(new Set((values ?? []).filter(Boolean).map(value => String(value).trim()).filter(Boolean)));
}

function extractJsonObject(text) {
    const source = String(text ?? '').trim();
    const start = source.indexOf('{');
    if (start === -1) {
        return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index++) {
        const char = source[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    return null;
}

function parseJsonObject(text) {
    const jsonText = extractJsonObject(text);
    if (!jsonText) {
        throw new Error('No JSON object found in analysis response');
    }

    return JSON.parse(jsonText);
}

function normalizeReroutedSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(segment => ({
            speaker: String(segment?.speaker ?? '').trim(),
            text: normalizeReplyText(segment?.text ?? ''),
        }))
        .filter(segment => segment.speaker && segment.text);
}

function normalizeStructuredAnalysisResult(payload) {
    const parsed = typeof payload === 'string' ? parseJsonObject(payload) : payload;
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Analysis response is not an object');
    }

    return {
        cleanText: normalizeReplyText(parsed.cleanText ?? ''),
        confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
        rewriteNeeded: Boolean(parsed.rewriteNeeded),
        issues: uniqueIssues(parsed.issues),
        reroutedSegments: normalizeReroutedSegments(parsed.reroutedSegments),
    };
}

function shouldAnalyzeWithLlm({ analysis, originalText, expectedName, userNames, otherNames, force = false }) {
    const attributionSignals = detectAttributionSignals({
        text: originalText,
        expectedName,
        userNames,
        otherNames,
    });

    if (force) {
        return { shouldAnalyze: true, attributionSignals };
    }

    if (!getSettings().autoAnalyzeAmbiguous) {
        return { shouldAnalyze: false, attributionSignals };
    }

    const alreadyHandled = analysis.issues.includes('user_content_truncated') || analysis.issues.includes('other_character_removed');
    return {
        shouldAnalyze: attributionSignals.length > 0 && !alreadyHandled,
        attributionSignals,
    };
}

function shouldRewriteReply(analysis) {
    const settings = getSettings();
    if (!settings.autoRewrite) {
        return false;
    }

    const hasRewriteTrigger = analysis.issues.some(issue => REWRITE_TRIGGER_ISSUES.has(issue));

    if (settings.rewriteAllReplies) {
        return hasRewriteTrigger || analysis.issues.length === 0;
    }

    return hasRewriteTrigger;
}

function mergeReroutedSegments(leftSegments, rightSegments) {
    const merged = [];

    for (const segment of [...leftSegments, ...rightSegments]) {
        const lastSegment = merged.at(-1);
        if (lastSegment && lastSegment.speaker === segment.speaker) {
            lastSegment.text = normalizeReplyText(`${lastSegment.text}\n${segment.text}`);
            continue;
        }

        merged.push({ speaker: segment.speaker, text: normalizeReplyText(segment.text) });
    }

    return merged.filter(segment => segment.text);
}

function filterUnsupportedReroutedSegments(originalText, reroutedSegments, expectedName, userNames, otherNames) {
    const allNames = [expectedName, ...userNames, ...otherNames];

    return normalizeReroutedSegments(reroutedSegments).filter(segment => hasSpeakerReferenceEvidence({
        text: originalText,
        speakerName: segment.speaker,
        allNames,
    }));
}

async function rewriteReply(context, expectedCharacter, candidateText, analysis, messageId) {
    const settings = getSettings();
    const profile = runtimeState.participantProfiles.get(expectedCharacter.name) ?? buildCharacterProfile(context, runtimeState.expectedCharacterId);

    const prompt = [
        `Task: Rewrite the candidate reply as the final in-character message from ${expectedCharacter.name}.`,
        'Hard requirements:',
        '- Output only the repaired final reply text.',
        '- Do not explain, analyze, summarize, or discuss the task.',
        '- Do not mention the user, detected issues, candidate reply, participants list, or recent context labels.',
        '- Only the expected speaker may act, think, narrate, or speak.',
        '- Preserve the intended meaning when possible, but remove contamination and nonsense.',
        profile?.description && `Description: ${profile.description}`,
        profile?.personality && `Personality: ${profile.personality}`,
        profile?.scenario && `Scenario: ${profile.scenario}`,
        profile?.mesExamples && `Dialogue examples: ${profile.mesExamples}`,
        profile?.firstMessage && `First message: ${profile.firstMessage}`,
        `Detected issues: ${analysis.issues.length ? analysis.issues.join(', ') : 'none'}`,
        `Participants summary:\n${buildParticipantsSummary(expectedCharacter.name)}`,
        `Recent conversation:\n${getRecentContext(context, messageId) || 'None available.'}`,
        `Candidate reply to repair:\n<reply>\n${candidateText}\n</reply>`,
        `Final reply from ${expectedCharacter.name}:`,
    ].filter(Boolean).join('\n\n');

    const generateAttempt = async (systemPrompt) => normalizeReplyText(await context.generateRaw({
        prompt,
        systemPrompt,
        responseLength: settings.rewriteResponseLength,
        trimNames: true,
    }));

    let rewritten = await generateAttempt(settings.rewriteSystemPrompt);
    let rewriteIssues = detectQualityIssues(rewritten);

    if (rewriteIssues.includes('meta_rewrite_response')) {
        rewritten = await generateAttempt([
            settings.rewriteSystemPrompt,
            'Your previous answer was invalid because it explained the task instead of writing the reply.',
            'Retry now and output only the final in-character reply text. No preamble. No analysis. No bullets. No labels.',
        ].join(' '));
        rewriteIssues = detectQualityIssues(rewritten);
    }

    if (rewriteIssues.includes('meta_rewrite_response')) {
        return {
            text: null,
            issues: ['rewrite_meta_response'],
        };
    }

    return {
        text: rewritten,
        issues: rewriteIssues,
    };
}

async function analyzeReplyWithLlm(context, expectedCharacter, candidateText, baseAnalysis, messageId, userNames, otherNames) {
    const settings = getSettings();
    const profile = runtimeState.participantProfiles.get(expectedCharacter.name)
        ?? buildCharacterProfile(context, context.characters.findIndex(character => character === expectedCharacter));
    const prompt = [
        `Expected speaker: ${expectedCharacter.name}`,
        `User aliases: ${userNames.length ? userNames.join(', ') : 'None'}`,
        `Other participants: ${otherNames.length ? otherNames.join(', ') : 'None'}`,
        profile?.description && `Description: ${profile.description}`,
        profile?.personality && `Personality: ${profile.personality}`,
        profile?.scenario && `Scenario: ${profile.scenario}`,
        profile?.mesExamples && `Dialogue examples: ${profile.mesExamples}`,
        `Deterministic issues: ${baseAnalysis.issues.length ? baseAnalysis.issues.join(', ') : 'none'}`,
        `Recent conversation:\n${getRecentContext(context, messageId) || 'None available.'}`,
        `Participants summary:\n${buildParticipantsSummary(expectedCharacter.name)}`,
        'Reroute rules:',
        `- Keep text on ${expectedCharacter.name} when it only mentions another participant by name.`,
        `- Example to keep: ${expectedCharacter.name} says, "Sofia is dressing like a disco angel." That is still ${expectedCharacter.name}'s message.`,
        '- A quote may still belong to another speaker if the surrounding prose clearly attributes it, for example: "Not this time," Bob replied.',
        '- Only reroute when another participant is explicitly labeled as the speaker or is clearly the actor of a separate segment.',
        `Candidate reply:\n<reply>\n${candidateText}\n</reply>`,
        'Return a JSON object with these fields only:',
        '- cleanText: the text that should remain on the expected character message',
        '- confidence: low, medium, or high',
        '- rewriteNeeded: true if the reply still needs a tone or coherence rewrite after attribution cleanup',
        '- issues: string array describing detected problems',
        '- reroutedSegments: array of { speaker, text } for lines that clearly belong to another participant',
    ].filter(Boolean).join('\n\n');

    const fallbackPrompt = `${prompt}\n\nReturn one JSON object only. No markdown fences. No explanation.`;

    try {
        const rawResponse = await context.generateRaw({
            prompt,
            systemPrompt: settings.analysisSystemPrompt,
            responseLength: settings.analysisResponseLength,
            trimNames: false,
            jsonSchema: ANALYSIS_RESPONSE_SCHEMA,
        });

        return normalizeStructuredAnalysisResult(rawResponse);
    } catch (error) {
        console.warn('[Group Reply Guard] Structured analysis failed, retrying with plain JSON prompt', error);
        const rawFallback = await context.generateRaw({
            prompt: fallbackPrompt,
            systemPrompt: settings.analysisSystemPrompt,
            responseLength: settings.analysisResponseLength,
            trimNames: false,
        });

        return normalizeStructuredAnalysisResult(rawFallback);
    }
}

async function dispatchReroutedSegments(context, reroutedSegments) {
    for (const segment of reroutedSegments) {
        runtimeState.suppressNextMessages++;
        const escapedName = String(segment.speaker).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const payload = JSON.stringify(segment.text);
        await context.executeSlashCommandsWithOptions(`/sendas name="${escapedName}" ${payload}`, {
            handleExecutionErrors: true,
            source: MODULE_NAME,
        });
    }
}

function shouldProcessMessage(message) {
    const settings = getSettings();
    const context = getContext();

    if (!settings.enabled || !context.groupId || !message || message.is_user || message.is_system) {
        return false;
    }

    if (message.extra?.[MODULE_NAME]?.processed) {
        return false;
    }

    if (runtimeState.suppressNextMessages > 0) {
        runtimeState.suppressNextMessages--;
        return false;
    }

    return true;
}

async function finalizePendingMessageUpdate(messageId, { rerenderMessage = true } = {}) {
    const context = getContext();
    const pending = runtimeState.pendingByMessageId.get(Number(messageId));

    if (!pending) {
        return false;
    }

    const message = context.chat[Number(messageId)];
    if (message && pending.changed && rerenderMessage) {
        context.updateMessageBlock(Number(messageId), message);
    }

    const rerouteDispatched = pending.reroutedSegments.length > 0 && shouldDispatchReroutedSegments(pending.source);

    if (rerouteDispatched) {
        setStatus('Dispatching rerouted segments');
        await dispatchReroutedSegments(context, pending.reroutedSegments);
    }

    await context.saveChat();
    runtimeState.pendingByMessageId.delete(Number(messageId));
    setStatus('Idle');

    const postGuardPayload = createPostGuardEventPayload({
        ...pending,
        rerouteDispatched,
    });

    try {
        await eventSource.emit(GROUP_REPLY_GUARD_POST_GUARD_EVENT, postGuardPayload);
    } catch (error) {
        console.warn('[Group Reply Guard] Post-guard event listener failed', error);
    }

    return true;
}

function upsertManualAction(messageId) {
    const settings = getSettings();
    const context = getContext();
    const message = context.chat[Number(messageId)];
    const messageElement = getMessageElement(messageId);

    if (!(messageElement instanceof HTMLElement)) {
        return;
    }

    messageElement.querySelector('.group_reply_guard_action')?.remove();

    if (!settings.enabled || !settings.manualMessageActions || !isCharacterMessage(message)) {
        return;
    }

    const buttons = messageElement.querySelector('.extraMesButtons');
    if (!(buttons instanceof HTMLElement)) {
        return;
    }

    const action = document.createElement('div');
    action.className = 'mes_button group_reply_guard_action fa-solid fa-shield-halved';
    action.dataset.messageId = String(messageId);

    const processed = Boolean(message?.extra?.[MODULE_NAME]?.processedAt);
    action.title = processed ? 'Re-analyze reply' : 'Analyze reply';
    action.setAttribute('data-i18n', `[title]${action.title}`);
    buttons.prepend(action);
}

async function processMessage(messageId, {
    source = 'auto',
    preferDrafted = false,
    bypassProcessed = false,
    forceLlmAnalysis = false,
    allowMutation = true,
} = {}) {
    const context = getContext();
    const message = context.chat[Number(messageId)];

    if (!message || !isCharacterMessage(message)) {
        return { changed: false, issues: [], llmAnalysisUsed: false };
    }

    if (!bypassProcessed && !shouldProcessMessage(message)) {
        return { changed: false, issues: [], llmAnalysisUsed: false };
    }

    refreshParticipantProfiles(context);
    const expectedCharacter = resolveExpectedCharacter(context, message, { preferDrafted });
    if (!expectedCharacter) {
        return { changed: false, issues: ['expected_speaker_missing'], llmAnalysisUsed: false };
    }

    setStatus(`${source === 'manual' ? 'Analyzing' : 'Inspecting'} ${expectedCharacter.name}`);

    const originalText = normalizeReplyText(message.mes);
    const userNames = getUserNames(context);
    const otherNames = Array.from(runtimeState.participantProfiles.keys()).filter(name => name !== expectedCharacter.name);

    let analysis = sanitizeGeneratedReply({
        text: originalText,
        expectedName: expectedCharacter.name,
        userNames,
        otherNames,
    });

    let finalText = analysis.cleanText || originalText;
    let rewriteApplied = false;
    let llmAnalysisUsed = false;

    const llmDecision = shouldAnalyzeWithLlm({
        analysis,
        originalText,
        expectedName: expectedCharacter.name,
        userNames,
        otherNames,
        force: forceLlmAnalysis,
    });

    analysis.issues = uniqueIssues([...analysis.issues, ...llmDecision.attributionSignals]);

    if (llmDecision.shouldAnalyze) {
        try {
            setStatus(`LLM analysis for ${expectedCharacter.name}`);
            const llmAnalysis = await analyzeReplyWithLlm(context, expectedCharacter, originalText, analysis, messageId, userNames, otherNames);
            const llmSanitized = sanitizeGeneratedReply({
                text: llmAnalysis.cleanText,
                expectedName: expectedCharacter.name,
                userNames,
                otherNames,
            });
            const llmReroutedSegments = mergeReroutedSegments(llmAnalysis.reroutedSegments, llmSanitized.reroutedSegments);
            const supportedLlmReroutes = filterUnsupportedReroutedSegments(
                originalText,
                llmReroutedSegments,
                expectedCharacter.name,
                userNames,
                otherNames,
            );
            const rejectedLlmReroute = llmReroutedSegments.length !== supportedLlmReroutes.length;

            llmAnalysisUsed = true;
            if (rejectedLlmReroute) {
                analysis = {
                    cleanText: finalText,
                    issues: uniqueIssues([
                        ...analysis.issues,
                        ...llmAnalysis.issues,
                        ...(llmAnalysis.rewriteNeeded ? ['llm_rewrite_recommended'] : []),
                        'llm_reroute_rejected',
                    ]),
                    reroutedSegments: analysis.reroutedSegments,
                    modified: analysis.modified,
                };
            } else {
                finalText = llmSanitized.cleanText || llmAnalysis.cleanText || finalText;
                analysis = {
                    cleanText: finalText,
                    issues: uniqueIssues([...analysis.issues, ...llmAnalysis.issues, ...llmSanitized.issues, ...(llmAnalysis.rewriteNeeded ? ['llm_rewrite_recommended'] : [])]),
                    reroutedSegments: mergeReroutedSegments(analysis.reroutedSegments, supportedLlmReroutes),
                    modified: analysis.modified || llmSanitized.modified || finalText !== originalText,
                };
            }
        } catch (error) {
            console.warn('[Group Reply Guard] LLM analysis failed', error);
            analysis.issues = uniqueIssues([...analysis.issues, 'llm_analysis_failed']);
        }
    }

    if (shouldRewriteReply(analysis)) {
        try {
            setStatus(`Rewriting ${expectedCharacter.name}`);
            const rewriteResult = await rewriteReply(context, expectedCharacter, finalText || originalText, analysis, messageId);
            if (rewriteResult.text) {
                const rewritten = rewriteResult.text;
                rewriteApplied = rewritten !== finalText;
                const rewrittenAnalysis = sanitizeGeneratedReply({
                    text: rewritten,
                    expectedName: expectedCharacter.name,
                    userNames,
                    otherNames,
                });
                finalText = rewrittenAnalysis.cleanText || finalText;
                analysis = {
                    cleanText: finalText,
                    issues: uniqueIssues([...analysis.issues, ...rewriteResult.issues, ...rewrittenAnalysis.issues, ...(rewriteApplied ? ['rewritten'] : [])]),
                    reroutedSegments: mergeReroutedSegments(analysis.reroutedSegments, rewrittenAnalysis.reroutedSegments),
                    modified: analysis.modified || rewrittenAnalysis.modified || rewriteApplied,
                };
            } else if (rewriteResult.issues?.length) {
                analysis.issues = uniqueIssues([...analysis.issues, ...rewriteResult.issues]);
            }
        } catch (error) {
            console.warn('[Group Reply Guard] Rewrite failed', error);
            analysis.issues = uniqueIssues([...analysis.issues, 'rewrite_failed']);
        }
    }

    const qualityIssues = detectQualityIssues(finalText);
    analysis.issues = uniqueIssues([...analysis.issues, ...qualityIssues]);
    finalText = normalizeReplyText(finalText || originalText);

    if (!finalText) {
        finalText = originalText;
        analysis.issues = uniqueIssues([...analysis.issues, 'empty_after_cleanup']);
    }

    const changed = allowMutation && finalText !== message.mes;
    if (changed) {
        message.mes = finalText;
    }

    message.extra = message.extra || {};
    const processedAt = Date.now();

    message.extra[MODULE_NAME] = {
        processed: true,
        expectedSpeaker: expectedCharacter.name,
        issues: analysis.issues,
        rewriteApplied,
        llmAnalysisUsed,
        lastSource: source,
        lastPreview: allowMutation ? undefined : finalText,
        processedAt,
    };

    if (allowMutation) {
        runtimeState.pendingByMessageId.set(Number(messageId), {
            messageId: Number(messageId),
            reroutedSegments: analysis.reroutedSegments,
            changed,
            source,
            expectedSpeaker: expectedCharacter.name,
            finalText,
            issues: [...analysis.issues],
            llmAnalysisUsed,
            rewriteApplied,
            processedAt,
        });
    }

    addDiagnostic({
        timestamp: Date.now(),
        speaker: expectedCharacter.name,
        source,
        llmAnalysisUsed,
        mutated: allowMutation && changed,
        issues: analysis.issues,
        rerouted: analysis.reroutedSegments.map(segment => segment.speaker),
        originalText,
        originalPreview: truncateText(originalText, 220),
        fullText: finalText,
        preview: truncateText(finalText, 220),
    });

    setStatus(`${source === 'manual' ? 'Analyzed' : 'Guarded'} ${expectedCharacter.name}`);

    return {
        changed,
        issues: analysis.issues,
        llmAnalysisUsed,
        preview: finalText,
    };
}

async function handleMessageReceived(messageId) {
    await processMessage(messageId, {
        source: 'auto',
        preferDrafted: true,
        bypassProcessed: false,
        forceLlmAnalysis: false,
        allowMutation: true,
    });
}

async function handleCharacterMessageRendered(messageId) {
    await finalizePendingMessageUpdate(messageId, { rerenderMessage: true });
    upsertManualAction(messageId);
}

async function handleManualActionClick(event) {
    const button = event.target instanceof Element ? event.target.closest('.group_reply_guard_action') : null;
    if (!(button instanceof HTMLElement)) {
        return;
    }

    event.preventDefault();

    if (button.dataset.busy === 'true') {
        return;
    }

    const messageId = Number(button.dataset.messageId);
    if (!Number.isInteger(messageId)) {
        return;
    }

    const context = getContext();
    const message = context.chat[messageId];
    if (!isCharacterMessage(message)) {
        return;
    }

    button.dataset.busy = 'true';
    button.classList.add('group_reply_guard_action_busy', 'fa-spinner', 'fa-spin');
    button.classList.remove('fa-shield-halved');

    try {
        const result = await processMessage(messageId, {
            source: 'manual',
            preferDrafted: false,
            bypassProcessed: true,
            forceLlmAnalysis: true,
            allowMutation: getSettings().manualAnalysisCanMutate,
        });

        if (getSettings().manualAnalysisCanMutate) {
            await finalizePendingMessageUpdate(messageId, { rerenderMessage: true });
            showToast('success', result.changed ? 'Reply re-analyzed and updated.' : 'Reply analyzed. No change needed.');
        } else {
            await context.saveChat();
            showToast('info', 'Reply analyzed. Preview saved in diagnostics without changing the message.');
        }
    } catch (error) {
        console.warn('[Group Reply Guard] Manual analysis failed', error);
        showToast('error', 'Manual reply analysis failed.');
    } finally {
        button.dataset.busy = 'false';
        button.classList.remove('group_reply_guard_action_busy', 'fa-spinner', 'fa-spin');
        button.classList.add('fa-shield-halved');
        upsertManualAction(messageId);
    }
}

function bindSetting(selector, eventName, updater) {
    $(selector).on(eventName, (event) => {
        updater(event);
        saveSettingsDebounced();
    });
}

function loadSettingsIntoDom() {
    const settings = getSettings();
    $('#group_reply_guard_enabled').prop('checked', settings.enabled);
    $('#group_reply_guard_auto_rewrite').prop('checked', settings.autoRewrite);
    $('#group_reply_guard_auto_analysis').prop('checked', settings.autoAnalyzeAmbiguous);
    $('#group_reply_guard_rewrite_all').prop('checked', settings.rewriteAllReplies);
    $('#group_reply_guard_reroute_policy').val(settings.reroutePolicy);
    $('#group_reply_guard_manual_actions').prop('checked', settings.manualMessageActions);
    $('#group_reply_guard_manual_mutation').prop('checked', settings.manualAnalysisCanMutate);
    $('#group_reply_guard_debug').prop('checked', settings.debug);
    $('#group_reply_guard_context_window').val(settings.contextWindow);
    $('#group_reply_guard_analysis_length').val(settings.analysisResponseLength);
    $('#group_reply_guard_response_length').val(settings.rewriteResponseLength);
    $('#group_reply_guard_user_aliases').val(settings.userAliases);
    $('#group_reply_guard_analysis_prompt').val(settings.analysisSystemPrompt);
    $('#group_reply_guard_rewrite_prompt').val(settings.rewriteSystemPrompt);
}

async function initializeSettingsUi() {
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_MODULE, 'settings');
    const container = $('#extensions_settings').length ? $('#extensions_settings') : $('#extensions_settings2');
    if (!container.length) {
        console.warn('[Group Reply Guard] No stock extension settings container found');
        return;
    }

    $('#group_reply_guard_settings_root').remove();
    container.append(settingsHtml);
    loadSettingsIntoDom();
    renderDiagnostics();

    bindSetting('#group_reply_guard_enabled', 'input', () => {
        getSettings().enabled = $('#group_reply_guard_enabled').prop('checked');
    });
    bindSetting('#group_reply_guard_auto_rewrite', 'input', () => {
        getSettings().autoRewrite = $('#group_reply_guard_auto_rewrite').prop('checked');
    });
    bindSetting('#group_reply_guard_auto_analysis', 'input', () => {
        getSettings().autoAnalyzeAmbiguous = $('#group_reply_guard_auto_analysis').prop('checked');
    });
    bindSetting('#group_reply_guard_rewrite_all', 'input', () => {
        getSettings().rewriteAllReplies = $('#group_reply_guard_rewrite_all').prop('checked');
    });
    bindSetting('#group_reply_guard_reroute_policy', 'input', () => {
        const reroutePolicy = String($('#group_reply_guard_reroute_policy').val() ?? DEFAULT_SETTINGS.reroutePolicy);
        getSettings().reroutePolicy = Object.values(REROUTE_POLICIES).includes(reroutePolicy)
            ? reroutePolicy
            : DEFAULT_SETTINGS.reroutePolicy;
    });
    bindSetting('#group_reply_guard_manual_actions', 'input', () => {
        getSettings().manualMessageActions = $('#group_reply_guard_manual_actions').prop('checked');
    });
    bindSetting('#group_reply_guard_manual_mutation', 'input', () => {
        getSettings().manualAnalysisCanMutate = $('#group_reply_guard_manual_mutation').prop('checked');
    });
    bindSetting('#group_reply_guard_debug', 'input', () => {
        getSettings().debug = $('#group_reply_guard_debug').prop('checked');
        renderDiagnostics();
    });
    bindSetting('#group_reply_guard_context_window', 'input', () => {
        getSettings().contextWindow = Math.max(2, Number($('#group_reply_guard_context_window').val()) || DEFAULT_SETTINGS.contextWindow);
    });
    bindSetting('#group_reply_guard_analysis_length', 'input', () => {
        getSettings().analysisResponseLength = Math.max(64, Number($('#group_reply_guard_analysis_length').val()) || DEFAULT_SETTINGS.analysisResponseLength);
    });
    bindSetting('#group_reply_guard_response_length', 'input', () => {
        getSettings().rewriteResponseLength = Math.max(32, Number($('#group_reply_guard_response_length').val()) || DEFAULT_SETTINGS.rewriteResponseLength);
    });
    bindSetting('#group_reply_guard_user_aliases', 'input', () => {
        getSettings().userAliases = String($('#group_reply_guard_user_aliases').val() ?? '');
    });
    bindSetting('#group_reply_guard_analysis_prompt', 'input', () => {
        getSettings().analysisSystemPrompt = String($('#group_reply_guard_analysis_prompt').val() ?? DEFAULT_ANALYSIS_SYSTEM_PROMPT).trim() || DEFAULT_ANALYSIS_SYSTEM_PROMPT;
    });
    bindSetting('#group_reply_guard_rewrite_prompt', 'input', () => {
        getSettings().rewriteSystemPrompt = String($('#group_reply_guard_rewrite_prompt').val() ?? DEFAULT_REWRITE_SYSTEM_PROMPT).trim() || DEFAULT_REWRITE_SYSTEM_PROMPT;
    });
}

jQuery(async () => {
    getSettings();
    await initializeSettingsUi();
    $(document).on('click', '.group_reply_guard_action', handleManualActionClick);

    eventSource.on(event_types.CHAT_CHANGED, resetRuntimeState);
    eventSource.on(event_types.GROUP_WRAPPER_STARTED, () => {
        const context = getContext();
        refreshParticipantProfiles(context);
        setStatus('Group generation started');
    });
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, () => {
        runtimeState.expectedCharacterId = null;
        setExpectedSpeakerLabel('No drafted speaker');
        setStatus('Idle');
    });
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (characterId) => {
        runtimeState.expectedCharacterId = Number(characterId);
        const context = getContext();
        const character = context.characters[runtimeState.expectedCharacterId];
        setExpectedSpeakerLabel(character ? `Drafted: ${character.name}` : 'Drafted speaker unavailable');
    });

    eventSource.makeFirst(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleCharacterMessageRendered);
});
