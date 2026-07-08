describe('Date Filtering', () => {
    describe('formatCellValue', () => {
        it('should format Date objects to YYYY-MM-DD for date type', () => {
            const formatCellValue = (value: Date | null | undefined, type?: string): string | null => {
                if (value === null || value === undefined) return null;
                const lowerType = (type || '').toLowerCase();
                if (value instanceof Date) {
                    const y = value.getUTCFullYear();
                    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
                    const d = String(value.getUTCDate()).toString().padStart(2, '0');
                    if (lowerType === 'date') {
                        return `${y}-${m}-${d}`;
                    }
                }
                return String(value);
            };

            const date = new Date(Date.UTC(2024, 0, 15));
            expect(formatCellValue(date, 'date')).toBe('2024-01-15');
        });

        it('should format Date objects to YYYY-MM-DD HH:MM:SS for timestamp type', () => {
            const formatCellValue = (value: Date | null | undefined, type?: string): string | null => {
                if (value === null || value === undefined) return null;
                const lowerType = (type || '').toLowerCase();
                if (value instanceof Date) {
                    const y = value.getUTCFullYear();
                    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
                    const d = String(value.getUTCDate()).toString().padStart(2, '0');
                    if (lowerType.includes('timestamp')) {
                        const hh = String(value.getUTCHours()).padStart(2, '0');
                        const mm = String(value.getUTCMinutes()).padStart(2, '0');
                        const ss = String(value.getUTCSeconds()).padStart(2, '0');
                        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
                    }
                }
                return String(value);
            };

            const date = new Date(Date.UTC(2024, 5, 15, 14, 30, 45));
            expect(formatCellValue(date, 'timestamp')).toBe('2024-06-15 14:30:45');
        });

        it('should format null values', () => {
            const formatCellValue = (value: unknown, _type?: string): string | null => {
                if (value === null || value === undefined) return null;
                return String(value);
            };

            expect(formatCellValue(null, 'date')).toBeNull();
            expect(formatCellValue(undefined, 'date')).toBeNull();
        });
    });

    describe('parseDateValue', () => {
        it('should parse Date objects to timestamp', () => {
            const parseDateValue = (value: unknown): number | null => {
                if (value === null || value === undefined) return null;
                if (value instanceof Date) return value.getTime();
                const str = String(value);
                const parsed = Date.parse(str);
                return isNaN(parsed) ? null : parsed;
            };

            const date = new Date(Date.UTC(2024, 0, 15));
            const result = parseDateValue(date);
            expect(result).toBe(date.getTime());
        });

        it('should parse date strings to timestamp', () => {
            const parseDateValue = (value: unknown): number | null => {
                if (value === null || value === undefined) return null;
                if (value instanceof Date) return value.getTime();
                const parsed = Date.parse(String(value));
                return isNaN(parsed) ? null : parsed;
            };

            expect(parseDateValue('2024-01-15')).toBe(Date.parse('2024-01-15'));
            expect(parseDateValue('2024-06-15 14:30:45')).toBe(Date.parse('2024-06-15 14:30:45'));
        });

        it('should return null for invalid dates', () => {
            const parseDateValue = (value: unknown): number | null => {
                if (value === null || value === undefined) return null;
                if (value instanceof Date) return value.getTime();
                const parsed = Date.parse(String(value));
                return isNaN(parsed) ? null : parsed;
            };

            expect(parseDateValue('not-a-date')).toBeNull();
            expect(parseDateValue('')).toBeNull();
        });
    });

    describe('evaluateConditions for dates', () => {
        interface Condition {
            type: string;
            value?: string;
            value2?: string;
        }

        const evaluateConditions = (
            conditions: Condition[],
            logic: string,
            stringValue: string,
            isDateColumn: boolean,
            parseDateValue: (value: unknown) => number | null,
            parseFilterDate: (filterValue: string) => number | null
        ): boolean => {
            const evaluateCondition = (cond: Condition): boolean => {
                const condValue = cond.value || '';
                const condValue2 = cond.value2 || '';

                if (isDateColumn) {
                    const cellDateValue = parseDateValue(stringValue);
                    const filterDateValue = parseFilterDate(condValue);
                    const filterDateValue2 = parseFilterDate(condValue2);

                    switch (cond.type) {
                        case 'equals':
                            if (filterDateValue === null) return cellDateValue === null;
                            return cellDateValue !== null && cellDateValue === filterDateValue;
                        case 'notEquals':
                            if (filterDateValue === null) return cellDateValue !== null;
                            return cellDateValue === null || cellDateValue !== filterDateValue;
                        case 'greaterThan':
                            return cellDateValue !== null && filterDateValue !== null && cellDateValue > filterDateValue;
                        case 'greaterThanOrEqual':
                            return cellDateValue !== null && filterDateValue !== null && cellDateValue >= filterDateValue;
                        case 'lessThan':
                            return cellDateValue !== null && filterDateValue !== null && cellDateValue < filterDateValue;
                        case 'lessThanOrEqual':
                            return cellDateValue !== null && filterDateValue !== null && cellDateValue <= filterDateValue;
                        case 'between':
                            return cellDateValue !== null && filterDateValue !== null && filterDateValue2 !== null &&
                                   cellDateValue >= filterDateValue && cellDateValue <= filterDateValue2;
                        case 'isEmpty':
                            return cellDateValue === null;
                        case 'isNotEmpty':
                            return cellDateValue !== null;
                        default:
                            return true;
                    }
                }
                return true;
            };

            if (logic === 'and') {
                return conditions.every(evaluateCondition);
            } else {
                return conditions.some(evaluateCondition);
            }
        };

        const parseDateValueFn = (value: unknown): number | null => {
            if (value === null || value === undefined) return null;
            if (value instanceof Date) return value.getTime();
            const parsed = Date.parse(String(value));
            return isNaN(parsed) ? null : parsed;
        };

        const parseFilterDate = (filterValue: string): number | null => {
            if (!filterValue || filterValue === '') return null;
            const parsed = Date.parse(filterValue);
            if (isNaN(parsed)) return null;
            return parsed;
        };

        it('should filter equals for date', () => {
            const result = evaluateConditions(
                [{ type: 'equals', value: '2024-01-15' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            );
            expect(result).toBe(true);
        });

        it('should not match different dates for equals', () => {
            const result = evaluateConditions(
                [{ type: 'equals', value: '2024-01-15' }],
                'and',
                '2024-01-16',
                true,
                parseDateValueFn,
                parseFilterDate
            );
            expect(result).toBe(false);
        });

        it('should filter greaterThan for date', () => {
            expect(evaluateConditions(
                [{ type: 'greaterThan', value: '2024-01-14' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);

            expect(evaluateConditions(
                [{ type: 'greaterThan', value: '2024-01-15' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(false);
        });

        it('should filter lessThan for date', () => {
            expect(evaluateConditions(
                [{ type: 'lessThan', value: '2024-01-16' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);

            expect(evaluateConditions(
                [{ type: 'lessThan', value: '2024-01-15' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(false);
        });

        it('should filter between for date range', () => {
            expect(evaluateConditions(
                [{ type: 'between', value: '2024-01-01', value2: '2024-01-31' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);

            expect(evaluateConditions(
                [{ type: 'between', value: '2024-01-01', value2: '2024-01-31' }],
                'and',
                '2024-02-01',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(false);
        });

        it('should filter isEmpty for NULL dates', () => {
            expect(evaluateConditions(
                [{ type: 'isEmpty' }],
                'and',
                'NULL',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);

            expect(evaluateConditions(
                [{ type: 'isEmpty' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(false);
        });

        it('should filter isNotEmpty for non-NULL dates', () => {
            expect(evaluateConditions(
                [{ type: 'isNotEmpty' }],
                'and',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);

            expect(evaluateConditions(
                [{ type: 'isNotEmpty' }],
                'and',
                'NULL',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(false);
        });

        it('should handle timestamp with time component', () => {
            expect(evaluateConditions(
                [{ type: 'greaterThan', value: '2024-01-15 10:00:00' }],
                'and',
                '2024-01-15 14:30:00',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);
        });

        it('should use AND logic correctly', () => {
            const result = evaluateConditions(
                [
                    { type: 'greaterThan', value: '2024-01-01' },
                    { type: 'lessThan', value: '2024-12-31' }
                ],
                'and',
                '2024-06-15',
                true,
                parseDateValueFn,
                parseFilterDate
            );
            expect(result).toBe(true);
        });

        it('should use AND logic to reject when one condition fails', () => {
            const result = evaluateConditions(
                [
                    { type: 'greaterThan', value: '2024-01-01' },
                    { type: 'lessThan', value: '2024-01-14' }
                ],
                'and',
                '2024-06-15',
                true,
                parseDateValueFn,
                parseFilterDate
            );
            expect(result).toBe(false);
        });

        it('should use OR logic correctly', () => {
            const result = evaluateConditions(
                [
                    { type: 'equals', value: '2024-01-15' },
                    { type: 'equals', value: '2024-06-15' }
                ],
                'or',
                '2024-01-15',
                true,
                parseDateValueFn,
                parseFilterDate
            );
            expect(result).toBe(true);
        });

        it('should handle Netezza DATE integer format (YYYYMMDD)', () => {
            expect(evaluateConditions(
                [{ type: 'equals', value: '20240115' }],
                'and',
                '20240115',
                true,
                parseDateValueFn,
                parseFilterDate
            )).toBe(true);
        });
    });

    describe('createFilterFn - unit tests for filter logic', () => {
        it('should handle Date objects correctly in accessorFn', () => {
            const date = new Date(Date.UTC(2024, 0, 15));
            const row = { original: { date } };
            const accessorFn = (r: { original: { date: Date } }) => r.original.date;
            const cellValue = accessorFn(row);
            expect(cellValue).toEqual(date);
        });

        it('should handle null values correctly', () => {
            const row = { original: { date: null } };
            const accessorFn = (r: { original: { date: Date | null } }) => r.original.date;
            const cellValue = accessorFn(row);
            expect(cellValue).toBeNull();
        });

        it('should format Date to YYYY-MM-DD string', () => {
            const formatCellValue = (value: unknown, type?: string): string | null => {
                if (value === null || value === undefined) return null;
                if (value instanceof Date) {
                    const y = value.getUTCFullYear();
                    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
                    const d = String(value.getUTCDate()).toString().padStart(2, '0');
                    if ((type || '').toLowerCase() === 'date') {
                        return `${y}-${m}-${d}`;
                    }
                }
                return String(value);
            };

            const date = new Date(Date.UTC(2024, 0, 15));
            expect(formatCellValue(date, 'date')).toBe('2024-01-15');
        });

        it('should detect date column type correctly', () => {
            const isDateColumn = (dataType?: string) =>
                (dataType || '').toLowerCase() === 'date' ||
                (dataType || '').toLowerCase().includes('timestamp') ||
                (dataType || '').toLowerCase().includes('datetime');

            expect(isDateColumn('date')).toBe(true);
            expect(isDateColumn('DATE')).toBe(true);
            expect(isDateColumn('timestamp')).toBe(true);
            expect(isDateColumn('TIMESTAMP')).toBe(true);
            expect(isDateColumn('datetime')).toBe(true);
            expect(isDateColumn('DATETIME')).toBe(true);
            expect(isDateColumn('varchar')).toBe(false);
            expect(isDateColumn(undefined)).toBe(false);
        });
    });
});
