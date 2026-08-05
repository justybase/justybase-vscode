export interface ProcedureBlock {
  sql: string;
  startOffset: number;
  endOffset: number;
}

export interface ProcedureHeader {
  startOffset: number;
  endOffset: number;
}

export interface ViewBlock {
  sql: string;
  startOffset: number;
  endOffset: number;
}

export interface ViewHeader {
  startOffset: number;
  endOffset: number;
}

interface TriviaState {
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
}

const CREATE_PROCEDURE_REGEX = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/gi;
const CREATE_VIEW_REGEX = /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/gi;
const CREATE_PROCEDURE_OR_VIEW_REGEX = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|VIEW)\b/gi;
const END_PROC_LENGTH = 'END_PROC'.length;

const initialTriviaState = (): TriviaState => ({
  inSingleQuote: false,
  inDoubleQuote: false,
  inLineComment: false,
  inBlockComment: false,
});

/**
 * Finds procedure declarations without looking for their body terminator.
 * This is intentionally suitable for CodeLens passes on large documents.
 */
export function findProcedureHeaders(text: string): ProcedureHeader[] {
  return findHeaders(text, CREATE_PROCEDURE_REGEX);
}

/** Finds view declarations without scanning for their terminating semicolon. */
export function findViewHeaders(text: string): ViewHeader[] {
  return findHeaders(text, CREATE_VIEW_REGEX);
}

/** Finds procedure and view headers in one trivia scan for large documents. */
export function findProcedureAndViewHeaders(text: string): {
  procedures: ProcedureHeader[];
  views: ViewHeader[];
} {
  const procedures: ProcedureHeader[] = [];
  const views: ViewHeader[] = [];

  for (const header of findHeaders<ProcedureHeader>(text, CREATE_PROCEDURE_OR_VIEW_REGEX)) {
    const headerText = text.substring(header.startOffset, header.endOffset);
    if (/PROCEDURE$/i.test(headerText)) {
      procedures.push(header);
    } else {
      views.push(header);
    }
  }

  return { procedures, views };
}

function findHeaders<T extends ProcedureHeader>(text: string, regex: RegExp): T[] {
  const headers: T[] = [];
  let scanOffset = 0;
  let state = initialTriviaState();
  let match: RegExpExecArray | null;

  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    const codeState = advanceTrivia(text, scanOffset, match.index, state);
    state = codeState.state;
    scanOffset = codeState.offset;

    if (!hasTriviaState(codeState.state)) {
      headers.push({
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      } as T);
    }
  }

  return headers;
}

/** Finds complete procedure blocks, including the optional statement semicolon. */
export function findProcedureBlocks(text: string): ProcedureBlock[] {
  return findProcedureHeaders(text).flatMap((header) => {
    const endOffset = findProcedureEndOffset(text, header.startOffset);
    if (endOffset === undefined) {
      return [];
    }

    return [{
      sql: text.substring(header.startOffset, endOffset).trim(),
      startOffset: header.startOffset,
      endOffset,
    }];
  });
}

/** Resolves a procedure body only when the user invokes its CodeLens. */
export function extractProcedureBlock(text: string, startOffset: number): string | undefined {
  const endOffset = findProcedureEndOffset(text, startOffset);
  return endOffset === undefined ? undefined : text.substring(startOffset, endOffset).trim();
}

/** Finds a complete CREATE VIEW statement, including its terminating semicolon. */
export function findViewBlocks(text: string): ViewBlock[] {
  return findViewHeaders(text).flatMap((header) => {
    const endOffset = findStatementEndOffset(text, header.startOffset);
    if (endOffset === undefined) {
      return [];
    }

    return [{
      sql: text.substring(header.startOffset, endOffset).trim(),
      startOffset: header.startOffset,
      endOffset,
    }];
  });
}

/** Resolves a view statement only when the user invokes its CodeLens. */
export function extractViewStatement(text: string, startOffset: number): string | undefined {
  const endOffset = findStatementEndOffset(text, startOffset);
  return endOffset === undefined ? undefined : text.substring(startOffset, endOffset).trim();
}

function findProcedureEndOffset(text: string, startOffset: number): number | undefined {
  const state = initialTriviaState();

  for (let offset = startOffset; offset < text.length; offset++) {
    const char = text[offset];
    const nextChar = text[offset + 1] ?? '';

    if (state.inLineComment) {
      if (char === '\n') {
        state.inLineComment = false;
      }
      continue;
    }
    if (state.inBlockComment) {
      if (char === '*' && nextChar === '/') {
        state.inBlockComment = false;
        offset++;
      }
      continue;
    }
    if (state.inSingleQuote) {
      if (char === "'" && nextChar === "'") {
        offset++;
      } else if (char === "'") {
        state.inSingleQuote = false;
      }
      continue;
    }
    if (state.inDoubleQuote) {
      if (char === '"') {
        state.inDoubleQuote = false;
      }
      continue;
    }

    if (char === '-' && nextChar === '-') {
      state.inLineComment = true;
      offset++;
    } else if (char === '/' && nextChar === '*') {
      state.inBlockComment = true;
      offset++;
    } else if (char === "'") {
      state.inSingleQuote = true;
    } else if (char === '"') {
      state.inDoubleQuote = true;
    } else if (
      (char === 'E' || char === 'e') &&
      text.slice(offset, offset + END_PROC_LENGTH).toUpperCase() === 'END_PROC' &&
      isWordBoundary(text[offset - 1]) &&
      isWordBoundary(text[offset + END_PROC_LENGTH])
    ) {
      let endOffset = offset + END_PROC_LENGTH;
      while (endOffset < text.length && /\s/.test(text[endOffset])) {
        endOffset++;
      }
      return text[endOffset] === ';' ? endOffset + 1 : offset + END_PROC_LENGTH;
    }
  }

  return undefined;
}

function findStatementEndOffset(text: string, startOffset: number): number | undefined {
  const state = initialTriviaState();

  for (let offset = startOffset; offset < text.length; offset++) {
    const char = text[offset];
    const nextChar = text[offset + 1] ?? '';

    if (state.inLineComment) {
      if (char === '\n') {
        state.inLineComment = false;
      }
      continue;
    }
    if (state.inBlockComment) {
      if (char === '*' && nextChar === '/') {
        state.inBlockComment = false;
        offset++;
      }
      continue;
    }
    if (state.inSingleQuote) {
      if (char === "'" && nextChar === "'") {
        offset++;
      } else if (char === "'") {
        state.inSingleQuote = false;
      }
      continue;
    }
    if (state.inDoubleQuote) {
      if (char === '"') {
        state.inDoubleQuote = false;
      }
      continue;
    }

    if (char === '-' && nextChar === '-') {
      state.inLineComment = true;
      offset++;
    } else if (char === '/' && nextChar === '*') {
      state.inBlockComment = true;
      offset++;
    } else if (char === "'") {
      state.inSingleQuote = true;
    } else if (char === '"') {
      state.inDoubleQuote = true;
    } else if (char === ';') {
      return offset + 1;
    }
  }

  return undefined;
}

function advanceTrivia(
  text: string,
  startOffset: number,
  endOffset: number,
  initialState: TriviaState,
): { offset: number; state: TriviaState } {
  const state = { ...initialState };

  for (let offset = startOffset; offset < endOffset; offset++) {
    const char = text[offset];
    const nextChar = text[offset + 1] ?? '';

    if (state.inLineComment) {
      if (char === '\n') {
        state.inLineComment = false;
      }
    } else if (state.inBlockComment) {
      if (char === '*' && nextChar === '/') {
        state.inBlockComment = false;
        offset++;
      }
    } else if (state.inSingleQuote) {
      if (char === "'" && nextChar === "'") {
        offset++;
      } else if (char === "'") {
        state.inSingleQuote = false;
      }
    } else if (state.inDoubleQuote) {
      if (char === '"') {
        state.inDoubleQuote = false;
      }
    } else if (char === '-' && nextChar === '-') {
      state.inLineComment = true;
      offset++;
    } else if (char === '/' && nextChar === '*') {
      state.inBlockComment = true;
      offset++;
    } else if (char === "'") {
      state.inSingleQuote = true;
    } else if (char === '"') {
      state.inDoubleQuote = true;
    }
  }

  return { offset: endOffset, state };
}

function hasTriviaState(state: TriviaState): boolean {
  return state.inSingleQuote || state.inDoubleQuote || state.inLineComment || state.inBlockComment;
}

function isWordBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9_$]/.test(char);
}
