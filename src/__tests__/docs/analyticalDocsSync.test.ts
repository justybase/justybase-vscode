import * as fs from 'fs';
import * as path from 'path';
import { ANOMALY_RULES, renderRuleCatalogueMarkdown } from '../../../media/resultPanel/analytical/anomalyRules';
import { DETECTION_CHOICE_LABELS } from '../../../media/resultPanel/analytical/detectionConfig';
import { ANOMALY_RULE_IDS, ANALYTICAL_CATEGORY_MAX_DISTINCT } from '../../../media/resultPanel/analytical/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GUIDE_PATH = path.join(REPO_ROOT, 'docs', 'guide', 'user', 'analytical-view.md');
const CONTRACT_PATH = path.join(REPO_ROOT, 'docs', 'ANALYTICAL_CONTRACT.md');
const BEGIN = '<!-- ANALYTICAL_RULES:BEGIN -->';
const END = '<!-- ANALYTICAL_RULES:END -->';

function generatedBlock(markdown: string): string | null {
    const start = markdown.indexOf(BEGIN);
    const finish = markdown.indexOf(END);
    if (start < 0 || finish < start) return null;
    return markdown.slice(start + BEGIN.length, finish).trim();
}

describe('Analytical documentation stays in sync with the code', () => {
    const guide = fs.readFileSync(GUIDE_PATH, 'utf8');
    const contract = fs.readFileSync(CONTRACT_PATH, 'utf8');

    it('embeds the generated rule catalogue in the user guide', () => {
        const block = generatedBlock(guide);
        expect(block).not.toBeNull();
        // On mismatch the expected table is printed in the failure, ready to paste between the markers.
        expect(block).toBe(renderRuleCatalogueMarkdown());
    });

    it('keeps the rule id list and the rule catalogue identical', () => {
        expect([...ANOMALY_RULES.map(rule => rule.id)].sort()).toEqual([...ANOMALY_RULE_IDS].sort());
    });

    it('names every rule in the contract', () => {
        for (const rule of ANOMALY_RULES) {
            expect(contract).toContain(`\`${rule.id}\``);
        }
    });

    it('names every detection mode the guide offers', () => {
        expect(guide).toContain(DETECTION_CHOICE_LABELS.whole);
        expect(guide).toContain(DETECTION_CHOICE_LABELS.rest);
    });

    it('documents the disk cross-tab bounds and the empty-string contract', () => {
        // The category bound is the shared constant; the group bound lives only on the host.
        expect(contract).toContain(`${ANALYTICAL_CATEGORY_MAX_DISTINCT} distinct values`);
        expect(contract).toContain('5,000 groups');
        expect(contract).toContain('Empty strings are treated as null-like');
    });
});
