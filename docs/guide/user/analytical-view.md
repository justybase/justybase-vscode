---
title: Analytical View
description: Group result rows, compare each group with a baseline chosen for the question, and see why a group was flagged.
audience: user
category: Product guides
status: Supported
last_verified: 2026-10-16
product_version: 3.19.5
---

# Analytical View

The **Analytical** view groups the rows of a result by one to three columns and compares every group with a baseline. It lists the groups with an anomaly score, and the detail pane shows per-column statistics for the selected group. Use it to find a group whose values, nulls, dates or category mix differ from the others.

Open it from the **Analytical** entry of the view switcher in the result toolbar.

## Data boundaries

- Results held in memory are analysed up to 500,000 rows. Above that the view reports that the result is too large. Use **Move to disk** from the toolbar's More menu, and the result is analysed exactly from disk.
- Results on disk are analysed exactly over every spilled row. Nothing is sampled.
- Grid filters and the global search are **not** applied. The analysis always covers the whole loaded result, so a filtered grid does not change the groups.
- At most 500 groups are listed, largest first. Rows in smaller groups are counted and reported as unlisted.
- At most 60 columns are analysed. Columns used for grouping are excluded, as are identifier-like columns, meaning columns where almost every value is different.
- Quartiles (robust mode) and full category distributions (MIX_SHIFT) need extra database work on disk. Robust mode is available up to 500,000 rows on disk; above that it uses the whole result and says so in the header.

## Choosing grouping columns

Add up to three columns with the **Add column** menu, or accept one of the suggestions. Suggestions are low-cardinality columns, which give a readable number of groups. The groups update when you add or remove a column.

## Reading the list and the detail pane

Each group row shows its label, row count and share of the result, its anomaly score, and up to three flags. A group is **anomalous** from a score of 25.

The detail pane lists the columns of the selected group, with anomalies first. Each column shows its statistics and the same statistic for the baseline. Expand **Why?** on a flag to see the evidence: the method, the baseline, the observed and expected values, the threshold, the effect size and the sample sizes.

A **Reference** badge marks the reference group in reference mode. It is the yardstick, so it is never scored.

## Detection mode

The mode decides what each group is compared with. Open **Options** to change it. The header shows the mode that actually ran, for example `Mode: Peer groups · auto`. When a choice cannot run as asked, a notice says what was used instead.

| Choice | Each group is compared with | Runs when |
|---|---|---|
| Default (whole result) | every row of the result, the group included | always |
| Auto | the other groups (peer groups) when at least 8 groups have enough rows; otherwise the whole result | at least 8 qualifying groups |
| Whole result | every row of the result, the group included | always |
| Robust (median and IQR) | the whole result, with medians and the interquartile range instead of means and sigma | up to 500,000 rows (memory or disk) |
| Peer groups | the typical group, judged by robust z-scores against the other groups | at least 8 qualifying groups |
| Rest of result | every row outside the group (leave-one-out) | at least 2 listed groups |
| Reference group | one group you choose in Options; the reference itself is not scored | a reference group is chosen |

A group qualifies for peer comparison when it has at least the minimum group size rows (see Options) and at least 5 non-null values in the column being compared.

**Whole result.** A group that holds half of the rows pulls the average and the spread towards itself, so a large deviation is measured against a spread the group itself inflated. This masking is the reason for the other modes.

**Robust.** Scale comes from the interquartile range: a median shift is measured in robust sigma (IQR divided by 1.349), extremes are compared with Tukey fences three IQRs beyond the quartiles, and variability uses IQR over the median. Outliers and skew move the mean and sigma much less than they move these, so this mode flags fewer skewed-distribution artefacts.

**Peer groups.** Each group is judged against the typical group, not against all rows. The robust z-score is `(value - median of groups) / scale`, where the scale is 1.4826 times the median absolute deviation of the groups, floored at 5% of the median so that a tight set of peers does not make every group an outlier. A flag needs a z-score of at least 3.5 (scaled by sensitivity). This answers "unusual compared with the typical group"; if most groups share the same deviation, it will not stand out. Check with whole result or with a reference group.

**Rest of result.** Each group is compared with every row outside it. The baseline is computed exactly as the result minus the group, so a large group does not hide its own deviation. Top values cannot be subtracted, so value-level rules do not run against it.

**Reference group.** Choose the group every other group is compared with. Means are compared with Welch's test: the z-score uses both groups' spreads, and the effect size is the difference over the pooled sigma. The reference group itself is never scored, so the list shows how the others differ from it.

Options are saved per result, so each result remembers its own mode.

## Options

The **Options** panel changes the analysis without recomputing the data:

- **Detection mode**: see above.
- **Reference group**: shown in reference mode. Choose the group every other group is compared with.
- **Minimum group size**: groups with fewer rows are listed but are not scored (default 5).
- **Rules**: switch any rule off. A disabled rule removes its flags from every group.
- **Columns to analyse**: leave a column out. It disappears from the scores and from the detail pane.
- **Reset options** restores the defaults for all of the above.

The sensitivity control in the toolbar scales the effect-size thresholds: low gives fewer alerts, high gives more. Changing any option re-scores the result that is already computed.

## Rules

Every flag comes from one of the rules below. The thresholds are the normal-sensitivity values; sensitivity scales the effect-size ones. The table shows how each rule behaves in each mode: **Yes** means the rule runs as described, **Adapted** means it runs with a documented simplification, and **No** means it does not run in that mode.

Every rule is on by default. RARE_VALUE is a supporting signal: a rare value never makes a group anomalous on its own. MIX_SHIFT compares category shares for columns with at most 50 distinct values, after subtracting the noise expected for the group size.

<!-- ANALYTICAL_RULES:BEGIN -->
| Rule | Applies to | Whole result | Rest of result | Robust | Peer groups | Reference group | What it flags |
|---|---|---|---|---|---|---|---|
| Mean shift (`MEAN_SHIFT`) | measure | Yes | Yes | Adapted | Adapted | Yes | Whole and rest: group mean is at least 1 baseline sigma away (scaled) and its z-score is at least 3. Robust: the same on medians with IQR / 1.349. Peer: robust z-score of the mean against the peer groups. Reference: Welch z-score against the reference group. |
| Range outlier (`RANGE_OUTLIER`) | measure | Yes | Yes | Adapted | Adapted | Yes | Whole and rest: group min or max lies beyond 4 baseline sigmas from the baseline mean. Robust: beyond the Tukey fences (3 IQR). Peer: robust z-score of the extreme against the peers (at least 5, scaled). Reference: beyond 4 sigmas of the reference group. |
| High variability (`HIGH_VARIABILITY`) | measure | Yes | Yes | Adapted | Adapted | Yes | Group coefficient of variation is at least 3x the baseline CV (scaled) and at least 0.5; with zero means, sigma ratio at least 2.5x. Robust and peer modes use IQR-based and peer-relative variants of the same test. |
| Null rate change (`NULL_RATE_DELTA`) | any | Yes | Yes | Yes | Adapted | Yes | Null rate differs from the baseline by at least 20 percentage points (scaled). Peer mode also requires a robust z-score of at least 3.5 against the peer groups and a change of at least 10 points. |
| Constant in group (`CONSTANT_IN_GROUP`) | dimension, measure, unknown | Yes | Adapted | Yes | Yes | Yes | The group has at least 10 non-null values, all identical, while the baseline has at least 3 distinct values. |
| Dominant value (`TOP_VALUE_DOMINANCE`) | dimension, unknown | Yes | No | Yes | Adapted | Yes | One value makes up at least 60% of the group and is at least 40 points (scaled) more frequent than in the baseline. Peer mode compares the share with the peer groups instead (robust z-score of at least 3.5). |
| Rare value (`RARE_VALUE`) | dimension, unknown | Yes | Yes | Yes | Yes | Yes | A value occurs in exactly one group and at most 3 times in the whole result. Only for columns with at least 3 distinct values, at least 100 non-null rows and at most 50% distinct values; never makes a group anomalous on its own. |
| Date window shift (`DATE_WINDOW_SHIFT`) | date | Yes | Adapted | Yes | Adapted | Yes | Group date range starts at least 25% of the baseline span late or ends 25% early. Peer mode uses the median start and end of the peer groups. |
| Small group (`SMALL_GROUP`) | group | Yes | Yes | Yes | Yes | Adapted | Group is smaller than 10% of the median listed group size (at least 5 groups, median at least 10 rows). Reference mode compares with the reference group size instead. |
| Large group (`LARGE_GROUP`) | group | Yes | Yes | Yes | Yes | Adapted | Group is larger than 10 times the median listed group size. Reference mode compares with the reference group size instead. |
| Category mix shift (`MIX_SHIFT`) | dimension, unknown | Yes | Yes | Yes | Adapted | Yes | Share of rows per category differs from the baseline by more than the noise expected for the group size (total variation distance minus noise floor, at least 0.25, scaled). Only for columns with at most 50 distinct values. Peer mode compares with the median peer distribution. |
<!-- ANALYTICAL_RULES:END -->

## Limitations

- **Masking (whole result).** A group that holds most of the rows can hide its own deviation. Use robust, rest of result or a reference group to check.
- **Peer baseline.** Peer groups judge a group against the typical group. A deviation shared by most groups is not reported.
- **Minimum groups.** Peer comparison needs 8 qualifying groups, rest of result needs 2, and the auto choice falls back to the whole result below 8. Reference mode needs at least 10 non-null values in the reference group for each column.
- **Normality.** Whole-result and rest-of-result rules based on the mean and the standard deviation over-flag skewed distributions, such as amounts with a long tail. Robust and peer modes are designed for this case.
- **Category rules.** MIX_SHIFT and category shares only use columns with at most 50 distinct values. Other columns get no category rules.
- **Multiple comparisons.** Many groups, columns and rules mean that some flags are chance. The score saturates and sensitivity is adjustable, but there is no formal correction.
- **Approximate counts in memory.** Distinct values and top values are counted exactly up to a cap per group. Beyond it a column is marked approximate and the rules that need an exact count do not run for it. Results on disk count exactly.
- **Bounded cross-tabs on disk.** Per-group top values and category distributions are computed only up to 50 distinct values per column and 5,000 groups. Outside those bounds `TOP_VALUE_DOMINANCE` and `MIX_SHIFT` are not evaluated. Quartiles also need the column to be stored as a number, so a text measure column gets no robust statistics. The view reports the affected rules and columns in a notice.
- **Score is relative.** A score compares groups inside one result. It is not comparable across different queries.
