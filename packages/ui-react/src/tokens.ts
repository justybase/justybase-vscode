/** Product-neutral visual tokens. Product shells may add chrome around them. */
export const uiTokens = Object.freeze({
  color: Object.freeze({
    background: '#1e1e1e',
    surface: '#252526',
    surfaceRaised: '#2d2d2d',
    border: '#3c3c3c',
    text: '#cccccc',
    muted: '#9d9d9d',
    accent: '#007fd4',
    danger: '#f48771',
    warning: '#cca700',
    success: '#89d185',
    selection: '#094771',
    hover: '#2a2d2e',
  }),
  typography: Object.freeze({ fontSize: '12px', smallFontSize: '11px', lineHeight: '1.35' }),
  space: Object.freeze({ xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '12px', xxl: '16px' }),
  radius: Object.freeze({ sm: '3px', md: '5px' }),
  density: Object.freeze({ row: '30px', header: '34px', control: '26px', toolbar: '40px', tab: '32px' }),
  layout: Object.freeze({ sidebar: '360px' }),
});

export type UiTokens = typeof uiTokens;
