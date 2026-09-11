/** Product-neutral visual tokens. Product shells may add chrome around them. */
export const uiTokens = Object.freeze({
  color: Object.freeze({
    background: '#101522',
    surface: '#182033',
    surfaceRaised: '#202b42',
    border: '#33415f',
    text: '#edf2ff',
    muted: '#aeb9d4',
    accent: '#78a9ff',
    danger: '#ff8e8e',
    success: '#82d9aa',
  }),
  space: Object.freeze({ xs: '0.25rem', sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem' }),
  radius: Object.freeze({ sm: '4px', md: '8px' }),
  density: Object.freeze({ row: '2rem', control: '2.25rem' }),
});

export type UiTokens = typeof uiTokens;
