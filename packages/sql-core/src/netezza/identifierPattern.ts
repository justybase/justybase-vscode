// Chevrotain lexer analysis does not reliably handle Unicode property escapes here,
// so keep the identifier ranges explicit for runtime tokenization stability.
const NETEZZA_IDENTIFIER_START_CLASS = 'A-Za-z_\\u00C0-\\u024F\\u1E00-\\u1EFF';
const NETEZZA_IDENTIFIER_CONTINUE_CLASS = 'A-Za-z0-9_\\u00C0-\\u024F\\u1E00-\\u1EFF\\u0300-\\u036F';

// Netezza folds unquoted identifiers to uppercase, so only uppercase ASCII
// names can appear without quoting.  Lowercase ASCII names require
// double-quote delimiters.  Unicode extended Latin ranges are kept as-is
// since Netezza accepts accented characters in unquoted identifiers.
const NETEZZA_UNQUOTED_START = 'A-Z_\\u00C0-\\u024F\\u1E00-\\u1EFF';
const NETEZZA_UNQUOTED_CONTINUE = 'A-Z0-9_\\u00C0-\\u024F\\u1E00-\\u1EFF\\u0300-\\u036F';

export const NETEZZA_UNQUOTED_IDENTIFIER_PATTERN = new RegExp(
	// eslint-disable-next-line no-misleading-character-class
	`^[${NETEZZA_UNQUOTED_START}][${NETEZZA_UNQUOTED_CONTINUE}]*$`
);

export const NETEZZA_IDENTIFIER_TOKEN_PATTERN = new RegExp(
	// eslint-disable-next-line no-misleading-character-class
	`[${NETEZZA_IDENTIFIER_START_CLASS}][${NETEZZA_IDENTIFIER_CONTINUE_CLASS}]*`
);