import { MENU_ICON_SHAPES } from '../src/menuIcons';

describe('shared menu icon geometry', () => {
  it('defines at least one drawable shape for every icon', () => {
    for (const shapes of Object.values(MENU_ICON_SHAPES)) {
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        expect(Object.keys(shape.attrs).length).toBeGreaterThan(0);
      }
    }
  });

  it('paints paths and basic SVG primitives only, so every renderer can draw them', () => {
    for (const shapes of Object.values(MENU_ICON_SHAPES)) {
      for (const shape of shapes) {
        expect(['circle', 'ellipse', 'line', 'path', 'rect']).toContain(shape.tag);
      }
    }
  });

  it('uses open stroke paths instead of filled glyphs', () => {
    for (const shapes of Object.values(MENU_ICON_SHAPES)) {
      for (const shape of shapes) {
        expect(shape.attrs.fill).toBeUndefined();
        expect(shape.attrs.stroke).toBeUndefined();
      }
    }
  });
});
