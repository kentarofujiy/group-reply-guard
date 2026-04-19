// @ts-nocheck
export const QUALITY_MARKERS = [
    /\blittle did (?:he|she|they|you) know\b/i,
    /\bunbeknownst to\b/i,
    /\bmeanwhile,? unbeknownst\b/i,
    /\beveryone (?:knew|felt|realized|noticed)\b/i,
    /\bas an ai\b/i,
    /\booc\b/i,
];

export const META_RESPONSE_MARKERS = [
    /^the user wants me to\b/i,
    /^the detected issue\b/i,
    /^looking at the candidate reply\b/i,
    /^let me examine\b/i,
    /^it seems consistent with\b/i,
    /^based on the context\b/i,
    /\bcandidate reply\b/i,
    /\bdetected issue(?:s)?\b/i,
    /\bexpected speaker\b/i,
    /\brecent context\b/i,
    /\bparticipants:\s*$/im,
];

export const ATTRIBUTION_REFERENCE_MARKERS = [
    /\b(?:you|your)\b/i,
    /\b(?:he|she|they)\s+(?:said|asked|replied|responded)\b/i,
    /\b(?:turning|looking|glancing|speaking|talking)\s+to\b/i,
    /\b(?:addressing|replying|responding)\s+to\b/i,
];

const DIALOGUE_ATTRIBUTION_VERBS = [
    'said',
    'says',
    'asked',
    'asks',
    'replied',
    'responded',
    'answered',
    'added',
    'continued',
    'called',
    'shouted',
    'whispered',
    'murmured',
    'muttered',
    'snapped',
    'hissed',
    'cried',
    'yelled',
    'growled',
];

const DIALOGUE_VERB_PATTERN = DIALOGUE_ATTRIBUTION_VERBS.join('|');
const QUOTED_DIALOGUE_PATTERN = /["“]([^"“”\n]+)["”]/g;
const PROTECTED_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>|```json\b[\s\S]*?```/gi;

const OTHER_CHARACTER_REFERENCE_PATTERNS = [
    name => new RegExp(`\\b(?:to|toward|towards|at|with|for|about|around|near|beside|before|after)\\s+${escapeRegExp(name)}\\b`, 'i'),
    name => new RegExp(`\\b${escapeRegExp(name)}\\b\\s*,`, 'i'),
    name => new RegExp(`\\b${escapeRegExp(name)}\\b\\s+(?:said|says|asked|asks|replied|responded|answered|added|continued|called|shouted|whispered|murmured|laughed|laughs|smiled|smiles|grinned|grins|sighed|sighs|nodded|nods|waved|waves|gestured|gestures|stepped|steps|walked|walks|moved|moves|turned|turns|looked|looks|glanced|glances|spoke|speaks|talked|talks|answered|answers)\\b`, 'i'),
    name => new RegExp(`\\b(?:said|says|asked|asks|replied|responded|answered|added|continued|told|tell|tells|called|shouted|whispered|murmured|laughed|laughs|smiled|smiles|grinned|grins|sighed|sighs|nodded|nods|waved|waves|gestured|gestures|turned|turns|looked|looks|glanced|glances|spoke|speaks|talked|talks|motioned|motions|beckoned|beckons)\\b[^\n.!?]{0,40}\\b${escapeRegExp(name)}\\b`, 'i'),
];

function uniqueStrings(values) {
    return Array.from(new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean)));
}

function protectSpecialBlocks(text) {
    const blocks = [];
    const source = String(text ?? '');
    PROTECTED_BLOCK_PATTERN.lastIndex = 0;

    const protectedText = source.replace(PROTECTED_BLOCK_PATTERN, (match) => {
        const placeholder = `__GRG_PROTECTED_BLOCK_${blocks.length}__`;
        blocks.push({ placeholder, content: match });
        return placeholder;
    });

    PROTECTED_BLOCK_PATTERN.lastIndex = 0;
    return { protectedText, blocks };
}

function restoreSpecialBlocks(text, blocks = []) {
    let restored = String(text ?? '');

    for (const block of blocks) {
        restored = restored.replaceAll(block.placeholder, block.content);
    }

    return restored;
}

function stripQuotedDialogue(text) {
    const { protectedText, blocks } = protectSpecialBlocks(text);
    const stripped = protectedText.replace(/["“][^"“”\n]*["”]/g, ' ');
    return restoreSpecialBlocks(stripped, blocks);
}

function buildReferenceMatchers(names) {
    return uniqueStrings(names)
        .sort((left, right) => right.length - left.length)
        .map(name => ({
            name,
            patterns: OTHER_CHARACTER_REFERENCE_PATTERNS.map(createPattern => createPattern(name)),
        }));
}

function lineHasReferenceCue(line, matchers) {
    const unquotedLine = stripQuotedDialogue(line);

    return matchers.some(({ patterns }) => patterns.some(pattern => pattern.test(unquotedLine)));
}

function extractQuotedDialogue(line) {
    const source = String(line ?? '');
    const segments = [];
    QUOTED_DIALOGUE_PATTERN.lastIndex = 0;

    let match;
    while ((match = QUOTED_DIALOGUE_PATTERN.exec(source)) !== null) {
        const text = normalizeReplyText(match[1] ?? '');
        if (text) {
            segments.push(text);
        }
    }

    QUOTED_DIALOGUE_PATTERN.lastIndex = 0;
    return segments;
}

function detectAttributedQuoteSpeaker(line, names) {
    const source = String(line ?? '');
    const quotes = extractQuotedDialogue(source);
    if (!quotes.length) {
        return null;
    }

    const outsideQuotes = stripQuotedDialogue(source);
    const orderedNames = uniqueStrings(names).sort((left, right) => right.length - left.length);

    for (const name of orderedNames) {
        const escapedName = escapeRegExp(name);
        const speakerBeforeVerb = new RegExp(
            `\\b${escapedName}\\b(?:\\s*,)?\\s+(?:(?:\\w+ly)\\s+){0,2}(?:${DIALOGUE_VERB_PATTERN})\\b`,
            'i',
        );
        const speakerAfterVerb = new RegExp(
            `\\b(?:${DIALOGUE_VERB_PATTERN})\\b(?:\\s*,)?\\s+${escapedName}\\b`,
            'i',
        );
        const possessiveCarrier = new RegExp(
            `\\b${escapedName}(?:'s|’s)\\s+(?:(?:\\w+ly|\\w+ed|\\w+ing)\\s+){0,2}(?:voice|words|tone)\\b`,
            'i',
        );

        if (speakerBeforeVerb.test(outsideQuotes) || speakerAfterVerb.test(outsideQuotes) || possessiveCarrier.test(outsideQuotes)) {
            return {
                speaker: name,
                text: normalizeReplyText(quotes.join('\n')),
            };
        }
    }

    return null;
}

export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function truncateText(text, maxLength = 320) {
    const source = String(text ?? '').trim();
    if (source.length <= maxLength) {
        return source;
    }

    return `${source.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function normalizeReplyText(text) {
    const { protectedText, blocks } = protectSpecialBlocks(text);
    const lines = String(protectedText ?? '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.replace(/\s+$/g, ''));

    const normalized = [];
    let blankRun = 0;

    for (const line of lines) {
        if (!line.trim()) {
            blankRun++;
            if (blankRun <= 1) {
                normalized.push('');
            }
            continue;
        }

        blankRun = 0;
        normalized.push(line);
    }

    return restoreSpecialBlocks(normalized.join('\n').trim(), blocks);
}

function buildSpeakerMatchers(names) {
    return uniqueStrings(names)
        .sort((left, right) => right.length - left.length)
        .map(name => ({
            name,
            explicit: new RegExp(`^\\s*[>*_~\"'\\[]*${escapeRegExp(name)}\\s*(?:[:\\-\\u2013\\u2014]|[>])\\s*`, 'i'),
            action: new RegExp(`^\\s*[*_~]${escapeRegExp(name)}\\b\\s+`, 'i'),
        }));
}

export function detectExplicitSpeaker(line, names) {
    const source = String(line ?? '');
    for (const matcher of buildSpeakerMatchers(names)) {
        if (matcher.explicit.test(source) || matcher.action.test(source)) {
            return matcher.name;
        }
    }

    return null;
}

export function stripSpeakerPrefix(line, speakerName) {
    const source = String(line ?? '');
    const name = escapeRegExp(speakerName);

    const explicit = new RegExp(`^(\\s*[>*_~\"'\\[]*)${name}\\s*(?:[:\\-\\u2013\\u2014]|[>])\\s*`, 'i');
    if (explicit.test(source)) {
        return source.replace(explicit, '$1').trim();
    }

    const action = new RegExp(`^(\\s*[*_~])${name}\\b\\s+`, 'i');
    if (action.test(source)) {
        return source.replace(action, '$1').trim();
    }

    return source.trim();
}

function pushReroutedLine(reroutedSegments, speaker, line) {
    const text = String(line ?? '').trim();
    if (!text) {
        return;
    }

    const lastSegment = reroutedSegments.at(-1);
    if (lastSegment && lastSegment.speaker === speaker) {
        lastSegment.text = normalizeReplyText(`${lastSegment.text}\n${text}`);
        return;
    }

    reroutedSegments.push({ speaker, text });
}

export function detectQualityIssues(text) {
    const issues = [];
    const normalized = normalizeReplyText(text);

    if (!normalized) {
        issues.push('empty_after_cleanup');
        return issues;
    }

    const { protectedText } = protectSpecialBlocks(normalized);
    const meaningfulLines = protectedText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const seenLines = new Set();

    for (const line of meaningfulLines) {
        const key = line.toLowerCase();
        if (seenLines.has(key)) {
            issues.push('repetition_detected');
            break;
        }
        seenLines.add(key);
    }

    if (/(\b\w+\b)(?:\s+\1){3,}/i.test(protectedText)) {
        issues.push('nonsensical_repetition');
    }

    if (META_RESPONSE_MARKERS.some(pattern => pattern.test(protectedText))) {
        issues.push('meta_rewrite_response');
    }

    if (QUALITY_MARKERS.some(pattern => pattern.test(protectedText))) {
        issues.push('omniscient_or_meta_content');
    }

    return uniqueStrings(issues);
}

export function detectAttributionSignals({ text, expectedName, userNames = [], otherNames = [] }) {
    const normalized = normalizeReplyText(text);
    if (!normalized) {
        return [];
    }

    const { protectedText } = protectSpecialBlocks(normalized);
    const issues = [];
    const userList = uniqueStrings(userNames);
    const otherList = uniqueStrings(otherNames);
    const allNames = uniqueStrings([expectedName, ...userList, ...otherList]);
    const userMatchers = userList.map(name => ({ name, pattern: new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i') }));
    const otherMatchers = buildReferenceMatchers(otherList);

    let foundReference = false;

    for (const line of protectedText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const explicitSpeaker = detectExplicitSpeaker(trimmed, allNames);
        if (explicitSpeaker) {
            continue;
        }

        const unquotedLine = stripQuotedDialogue(trimmed);
        const hasUserReference = userMatchers.some(({ pattern }) => pattern.test(unquotedLine));
        const hasOtherReference = lineHasReferenceCue(trimmed, otherMatchers);

        if (hasUserReference) {
            issues.push('ambiguous_user_reference');
            foundReference = true;
        }

        if (hasOtherReference) {
            issues.push('ambiguous_other_character_reference');
            foundReference = true;
        }
    }

    if (foundReference || ATTRIBUTION_REFERENCE_MARKERS.some(pattern => pattern.test(protectedText))) {
        if (issues.length > 0) {
            issues.push('ambiguous_multi_character_prose');
        }
    }

    return uniqueStrings(issues);
}

export function hasSpeakerReferenceEvidence({ text, speakerName, allNames = [] }) {
    const normalized = normalizeReplyText(text);
    if (!normalized || !speakerName) {
        return false;
    }

    const { protectedText } = protectSpecialBlocks(normalized);
    const names = uniqueStrings([speakerName, ...allNames]);
    const speakerMatchers = buildReferenceMatchers([speakerName]);

    for (const line of protectedText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const explicitSpeaker = detectExplicitSpeaker(trimmed, names);
        if (explicitSpeaker && explicitSpeaker.toLowerCase() === String(speakerName).toLowerCase()) {
            return true;
        }

        const attributedQuote = detectAttributedQuoteSpeaker(trimmed, names);
        if (attributedQuote && attributedQuote.speaker.toLowerCase() === String(speakerName).toLowerCase()) {
            return true;
        }

        if (lineHasReferenceCue(trimmed, speakerMatchers)) {
            return true;
        }
    }

    return false;
}

export function sanitizeGeneratedReply({ text, expectedName, userNames = [], otherNames = [] }) {
    const source = normalizeReplyText(text);
    const { protectedText, blocks } = protectSpecialBlocks(source);
    const issues = [];
    const reroutedSegments = [];
    const keepLines = [];
    const names = uniqueStrings([expectedName, ...userNames, ...otherNames]);
    const userSet = new Set(uniqueStrings(userNames).map(name => name.toLowerCase()));
    const otherSet = new Set(uniqueStrings(otherNames).map(name => name.toLowerCase()));

    let activeSpeaker = expectedName;
    let truncatedForUser = false;

    for (const rawLine of protectedText.split('\n')) {
        if (!rawLine.trim()) {
            if (activeSpeaker === expectedName && keepLines.length > 0 && keepLines.at(-1) !== '') {
                keepLines.push('');
            }
            continue;
        }

        const trimmedLine = rawLine.trim();
        const isProtectedBlock = blocks.some(block => block.placeholder === trimmedLine);
        if (isProtectedBlock) {
            keepLines.push(trimmedLine);
            activeSpeaker = expectedName;
            continue;
        }

        const detectedSpeaker = detectExplicitSpeaker(rawLine, names);

        if (detectedSpeaker) {
            activeSpeaker = detectedSpeaker;
            const lowered = detectedSpeaker.toLowerCase();
            const stripped = stripSpeakerPrefix(rawLine, detectedSpeaker);

            if (userSet.has(lowered)) {
                issues.push('user_content_truncated');
                truncatedForUser = true;
                break;
            }

            if (otherSet.has(lowered)) {
                issues.push('other_character_removed');
                pushReroutedLine(reroutedSegments, detectedSpeaker, stripped);
                continue;
            }

            keepLines.push(stripped || rawLine.trim());
            continue;
        }

        const attributedQuote = detectAttributedQuoteSpeaker(rawLine, names);
        if (attributedQuote) {
            activeSpeaker = attributedQuote.speaker;
            const lowered = attributedQuote.speaker.toLowerCase();

            if (userSet.has(lowered)) {
                issues.push('user_content_truncated');
                truncatedForUser = true;
                break;
            }

            if (otherSet.has(lowered)) {
                issues.push('other_character_removed');
                pushReroutedLine(reroutedSegments, attributedQuote.speaker, attributedQuote.text || rawLine);
                activeSpeaker = expectedName;
                continue;
            }

            keepLines.push(rawLine.trimEnd());
            continue;
        }

        if (activeSpeaker && otherSet.has(activeSpeaker.toLowerCase())) {
            issues.push('other_character_removed');
            pushReroutedLine(reroutedSegments, activeSpeaker, rawLine);
            continue;
        }

        keepLines.push(rawLine.trimEnd());
    }

    const cleanText = restoreSpecialBlocks(normalizeReplyText(keepLines.join('\n')), blocks);

    if (truncatedForUser && !cleanText) {
        issues.push('empty_after_cleanup');
    }

    issues.push(...detectQualityIssues(cleanText));

    return {
        cleanText,
        reroutedSegments: reroutedSegments.map(segment => ({
            speaker: segment.speaker,
            text: restoreSpecialBlocks(segment.text, blocks),
        })),
        issues: uniqueStrings(issues),
        modified: cleanText !== source || reroutedSegments.length > 0,
    };
}
