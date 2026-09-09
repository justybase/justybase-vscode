import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import type { TuningReport } from '@justybase/contracts';
import { analyzeSnowflakeExplainPlan } from './snowflakeQueryProfile';

export class SnowflakeTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        return analyzeSnowflakeExplainPlan(input.explainPlanText || '', input.sql || '');
    }
}

export const snowflakeTuningAdvisor: DatabaseTuningAdvisor = new SnowflakeTuningAdvisor();
