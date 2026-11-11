import type { ReactNode } from 'react';
import { MENU_ICON_SHAPES, type MenuIconName, type MenuIconShape } from '@justybase/ui-core/menuIcons';

function MenuIconShapeNode({ shape }: { readonly shape: MenuIconShape }): ReactNode {
  switch (shape.tag) {
    case 'path':
      return <path {...shape.attrs} />;
    case 'rect':
      return <rect {...shape.attrs} />;
    case 'circle':
      return <circle {...shape.attrs} />;
    case 'ellipse':
      return <ellipse {...shape.attrs} />;
    case 'line':
      return <line {...shape.attrs} />;
    default:
      return null;
  }
}

/**
 * Decorative 14px stroke icon for the shared data-grid context menu. The
 * geometry comes from `@justybase/ui-core`, so webview menus and React menus
 * stay visually identical.
 */
export function MenuIcon({ name }: { readonly name: MenuIconName }): ReactNode {
  return (
    <span className="ui-menu-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {MENU_ICON_SHAPES[name].map((shape, index) => <MenuIconShapeNode shape={shape} key={index} />)}
      </svg>
    </span>
  );
}
