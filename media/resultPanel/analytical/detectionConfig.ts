// Detection mode choice and its resolution for the Analytical view. Pure: no DOM, no host calls.
// The choice is what the user picked; the effective mode is what the rules actually run with, after
// fallbacks (too few groups, quartiles unavailable, no reference group yet).

import { PEER_MIN_GROUPS } from './modeRules.js';
import type { DetectionChoice, DetectionMode } from './types.js';

/** Rest-of-result needs at least two listed groups: with one group the rest is empty. */
export const REST_MIN_GROUPS = 2;

export interface DetectionContext {
    /** Groups listed in the result. */
    listedGroups: number;
    /** Listed groups with at least the minimum number of rows; the peer comparison uses only these. */
    qualifyingGroups: number;
    /** Quartiles were computed for this result (robust mode needs them). */
    quantilesAvailable: boolean;
    /** The chosen reference group, when it is still listed in the result. */
    referenceKey?: string;
}

export interface ResolvedDetection {
    requested: DetectionChoice;
    effective: DetectionMode;
    /** True when 'auto' picked the effective mode. */
    viaAuto: boolean;
    /** Shown to the user when the requested mode could not run as asked. */
    notice?: string;
    /** The groups are not scored until the user acts (reference mode without a usable reference group). */
    blocked?: 'needs-reference';
}

export const DETECTION_CHOICE_LABELS: Record<DetectionChoice, string> = {
    default: 'Default (whole result)',
    auto: 'Auto',
    whole: 'Whole result',
    robust: 'Robust (median and IQR)',
    peer: 'Peer groups',
    rest: 'Rest of result',
    reference: 'Reference group',
};

export const DETECTION_CHOICE_HELP: Record<DetectionChoice, string> = {
    default: 'Each group is compared with the whole result, the group included. Same as Whole result.',
    auto: `Peer groups when the result has at least ${PEER_MIN_GROUPS} groups with enough rows, otherwise whole result.`,
    whole: 'Each group is compared with the whole result, the group included. Simple, but a large group can hide its own deviation.',
    robust: 'Medians and interquartile range instead of means and sigma. Less sensitive to skewed data and outliers.',
    peer: `Each group is judged against the typical group (robust z-scores). Needs at least ${PEER_MIN_GROUPS} groups.`,
    rest: 'Each group is compared with every row outside it (leave-one-out). Removes the masking effect of large groups.',
    reference: 'Each group is compared with a group you choose. The reference group itself is not scored.',
};

/** Choices offered in the options panel, in display order. */
export const DETECTION_CHOICES: readonly DetectionChoice[] = ['default', 'auto', 'whole', 'robust', 'peer', 'rest', 'reference'];

/** Short names for the mode header, describing what actually ran. */
export const DETECTION_MODE_NAME: Record<DetectionMode, string> = {
    whole: 'Whole result',
    rest: 'Rest of result',
    robust: 'Robust',
    peer: 'Peer groups',
    reference: 'Reference group',
};

export function resolveDetection(choice: DetectionChoice, context: DetectionContext): ResolvedDetection {
    switch (choice) {
        case 'auto':
            return context.qualifyingGroups >= PEER_MIN_GROUPS
                ? { requested: choice, effective: 'peer', viaAuto: true }
                : { requested: choice, effective: 'whole', viaAuto: true };
        case 'rest':
            if (context.listedGroups < REST_MIN_GROUPS) {
                return {
                    requested: choice,
                    effective: 'whole',
                    viaAuto: false,
                    notice: `Rest of result needs at least ${REST_MIN_GROUPS} groups; showing the whole result.`,
                };
            }
            return { requested: choice, effective: 'rest', viaAuto: false };
        case 'peer':
            if (context.qualifyingGroups < PEER_MIN_GROUPS) {
                return {
                    requested: choice,
                    effective: 'whole',
                    viaAuto: false,
                    notice: `Peer groups need at least ${PEER_MIN_GROUPS} groups with enough rows; showing the whole result.`,
                };
            }
            return { requested: choice, effective: 'peer', viaAuto: false };
        case 'robust':
            if (!context.quantilesAvailable) {
                return {
                    requested: choice,
                    effective: 'whole',
                    viaAuto: false,
                    notice: 'Robust statistics are not available for this result; showing the whole result.',
                };
            }
            return { requested: choice, effective: 'robust', viaAuto: false };
        case 'reference':
            if (context.referenceKey === undefined) {
                return {
                    requested: choice,
                    effective: 'reference',
                    viaAuto: false,
                    blocked: 'needs-reference',
                    notice: 'Choose a reference group in Options. Groups are not scored until then.',
                };
            }
            return { requested: choice, effective: 'reference', viaAuto: false };
        case 'whole':
        case 'default':
            return { requested: choice, effective: 'whole', viaAuto: false };
    }
}
