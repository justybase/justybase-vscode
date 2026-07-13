import * as vscode from 'vscode';
import {
  resetContextKeyStateForTests,
  setContextIfChanged,
} from '../services/contextKeyService';

jest.mock('vscode');

describe('contextKeyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetContextKeyStateForTests();
  });

  it('deduplicates 200 unchanged cursor-driven context updates', () => {
    for (let index = 0; index < 200; index++) {
      setContextIfChanged('netezza.resultsCopyPrimed', false);
      setContextIfChanged('netezza.resultsFocused', false);
      setContextIfChanged('netezza.resultsInputFocused', false);
    }

    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(3);
  });

  it('sends actual context transitions', () => {
    setContextIfChanged('netezza.resultsFocused', false);
    setContextIfChanged('netezza.resultsFocused', true);
    setContextIfChanged('netezza.resultsFocused', true);
    setContextIfChanged('netezza.resultsFocused', false);

    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(3);
  });
});
