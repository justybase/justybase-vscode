/**
 * ETL Designer - Webview Script
 * Contains all JavaScript code for the ETL Designer webview
 */

import { EtlProject } from '../../etl/etlTypes';
import { generateEtlDesignerScript } from './scripts/index';

/**
 * Generates the JavaScript code for the ETL Designer webview
 */
export function getEtlDesignerScript(project: EtlProject): string {
    return generateEtlDesignerScript(project);
}
