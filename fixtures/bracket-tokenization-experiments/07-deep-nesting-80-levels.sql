-- EXPERIMENT 07: 80 levels of nesting on a single long line
-- HOW TO TEST: compare color of leftmost '(' vs rightmost ')'.
-- EXPECT: same color index (modulo color pool size); hover finds correct partner.
-- NOTE: if colors diverge wildly, bracket tree may be corrupted or depth-limited.

SELECT ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((( 1 )))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))) AS deep_80;
