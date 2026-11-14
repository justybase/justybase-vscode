/**
 * Erase TypeScript class fields that have no initializer.
 *
 * `@babel/preset-typescript` emits `field!: Type;` as `this.field = undefined`.
 * TypeScript with `useDefineForClassFields: false` (this project's ES2020 emit)
 * erases such declarations entirely. The difference is observable in the
 * dialect parsers: they declare Chevrotain rules as `rule!: AnyRule` and assign
 * them during the base-class constructor, so Babel's `undefined` assignment
 * would wipe the rule out.
 */
module.exports = function eraseTypeOnlyClassFields() {
    return {
        name: 'justybase-erase-type-only-class-fields',
        visitor: {
            ClassProperty(path) {
                if (path.node.value == null) {
                    path.remove();
                }
            },
            ClassPrivateProperty(path) {
                if (path.node.value == null) {
                    path.remove();
                }
            },
        },
    };
};
