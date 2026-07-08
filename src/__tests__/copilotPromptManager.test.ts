/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { CopilotPromptManager } from '../services/copilot/CopilotPromptManager';

jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn(),
            update: jest.fn()
        })
    },
    env: {
        language: 'en'
    }
}), { virtual: true });

describe('CopilotPromptManager', () => {
    let promptManager: CopilotPromptManager;
    let mockReferenceProvider: { getReference: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();

        mockReferenceProvider = {
            getReference: jest.fn()
        };

        promptManager = new CopilotPromptManager(() => ({
            displayName: 'Netezza',
            referenceProvider: mockReferenceProvider
        }));
    });

    describe('getPrompt', () => {
        beforeEach(() => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(undefined)
            });
        });

        it('should get default optimize prompt', () => {
            const prompt = promptManager.getPrompt('optimize');

            expect(prompt).toContain('Optimize');
            expect(prompt).toContain('Netezza');
        });

        it('should get default fix prompt', () => {
            const prompt = promptManager.getPrompt('fix');

            expect(prompt).toContain('Fix');
            expect(prompt).toContain('syntax errors');
            expect(prompt).toContain('Netezza');
        });

        it('should get default explain prompt', () => {
            const prompt = promptManager.getPrompt('explain');

            expect(prompt).toContain('Explain');
            expect(prompt).toContain('what this Netezza SQL query does');
        });

        it('should get default best practices prompt', () => {
            const prompt = promptManager.getPrompt('bestPractices');

            expect(prompt).toContain('Rewrite');
            expect(prompt).toContain('Netezza best practices');
        });

        it('should use custom prompt from configuration', () => {
            const customPrompt = 'Custom optimize prompt for my project';
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue(customPrompt)
            });

            const prompt = promptManager.getPrompt('optimize');

            expect(prompt).toBe(customPrompt);
        });

        it('should use custom empty string from configuration', () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn().mockReturnValue('')
            });

            const prompt = promptManager.getPrompt('optimize');

            expect(prompt).toBe('');
        });
    });

    describe('buildSystemPrompt', () => {
        beforeEach(() => {
            mockReferenceProvider.getReference.mockReturnValue('NETEZZA REFERENCE CONTENT');
        });

        it('should build system prompt with context', () => {
            const context = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: 'CREATE TABLE users (id INT);',
                variables: 'Variables: @param1, @param2',
                recentQueries: 'Recent: SELECT * FROM orders',
                connectionInfo: 'Connected to TEST_DB'
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).toContain('expert Netezza');
            expect(prompt).toContain('SQL developer');
            expect(prompt).toContain('DBA');
            expect(prompt).toContain(context.selectedSql);
            expect(prompt).toContain(context.ddlContext);
            expect(prompt).toContain(context.variables);
            expect(prompt).toContain(context.recentQueries);
            expect(prompt).toContain(context.connectionInfo);
            expect(prompt).toContain('NETEZZA REFERENCE CONTENT');
        });

        it('should include strict rules', () => {
            const context = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).toContain('STRICT RULES:');
            expect(prompt).toContain('active Netezza dialect');
            expect(prompt).toContain('different database engine');
        });

        it('should not force response language in system prompt', () => {
            const context = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).not.toContain('Respond in');
        });

        it('should handle empty context', () => {
            const context = {
                selectedSql: '',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: ''
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).toContain('expert Netezza');
            expect(prompt).toContain('STRICT RULES:');
            expect(prompt).toContain('CONTEXT INFORMATION:');
            expect(prompt).toContain('DATABASE SCHEMA');
            expect(prompt).toContain('DETECTED VARIABLES:');
            expect(prompt).toContain('RECENT QUERY HISTORY:');
        });

        it('should call reference provider for optimization rules', () => {
            const context = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };

            promptManager.buildSystemPrompt(context);

            expect(mockReferenceProvider.getReference).toHaveBeenCalledWith('optimization');
        });

        it('should include workspace curated tables section', () => {
            const context = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected',
                workspaceTableProfilesContext: 'Workspace curated tables and notes:\n- TEST.ADMIN.USERS: Primary user table'
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).toContain('WORKSPACE CURATED TABLES');
            expect(prompt).toContain('Primary user table');
        });

        it('should handle null values in context', () => {
            const context = {
                selectedSql: null as any,
                ddlContext: null as any,
                variables: null as any,
                recentQueries: null as any,
                connectionInfo: null as any
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).toBeDefined();
            expect(prompt).toContain('STRICT RULES:');
        });

        it('should include Netezza naming conventions from reference', () => {
            mockReferenceProvider.getReference.mockReturnValue(
                'NETEZZA SQL NAMING CONVENTIONS:\n- Three-part name: DATABASE.SCHEMA.OBJECT\n- DATABASE..OBJECT'
            );

            const context = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };

            const prompt = promptManager.buildSystemPrompt(context);

            expect(prompt).toContain('NETEZZA SQL NAMING CONVENTIONS');
            expect(prompt).toContain('DATABASE.SCHEMA.OBJECT');
            expect(prompt).toContain('DATABASE..OBJECT');
        });
    });
});
