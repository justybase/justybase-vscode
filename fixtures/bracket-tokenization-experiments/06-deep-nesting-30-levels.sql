-- EXPERIMENT 06: 30 levels of parenthesis nesting (still under VS Code ~150 limit)
-- HOW TO TEST: hover innermost ')' — should jump to innermost '('.
-- EXPECT: colors cycle through bracket color pool; pairs still consistent.

SELECT (
  ( (
    ( ( ( ( ( ( ( ( ( (
      ( ( ( ( ( ( ( ( ( ( (
        ( ( ( ( ( ( ( ( ( 42
        ) ) ) ) ) ) ) ) )
      ) ) ) ) ) ) ) ) ) ) )
    ) ) ) ) ) ) ) ) ) )
  ) )
) AS deeply_nested;
