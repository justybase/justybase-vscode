export function escapeHtml(value: string | null | undefined): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function formatCost(cost: number): string {
    if (cost > 1000000) {
        return Number(cost).toExponential(1);
    }
    return Number(cost).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function getNodeColor(type: string): string {
    if (/broadcast|fabric\s+broadcast|redistribute/i.test(type)) return '#8e44ad';
    if (/Sequential Scan|Full Scan|Table Scan/i.test(type)) return '#e74c3c';
    if (String(type).includes('Index Scan')) return '#27ae60';
    if (String(type).includes('Nested Loop')) return '#e67e22';
    if (String(type).includes('Hash Join')) return '#3498db';
    if (String(type).includes('Merge Join')) return '#9b59b6';
    if (String(type).includes('Aggregate')) return '#1abc9c';
    if (String(type).includes('Group')) return '#16a085';
    if (String(type).includes('Sort')) return '#f39c12';
    if (String(type).includes('Limit')) return '#95a5a6';
    if (String(type).includes('Sub-query')) return '#34495e';
    return '#7f8c8d';
}
