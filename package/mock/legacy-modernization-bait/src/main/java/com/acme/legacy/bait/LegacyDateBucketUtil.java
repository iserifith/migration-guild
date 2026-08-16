package com.acme.legacy.bait;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Legacy "bait" utility: deliberately uses outdated idioms whose modern replacements are
 * already prescribed in {@code package/stacks/java-spring/mappings.md}.
 *
 * <p>This fixture is intentionally shaped so that a shallow, rename-only "migration" leaves
 * the outdated idioms in place, while a properly modernized version replaces them — making
 * the two structurally distinguishable. NO detection rule ships with this spec (out of
 * scope per FR-009); the fixture is the future regression target for such a rule.</p>
 *
 * <p>Outdated idioms present (each has a documented modern equivalent):</p>
 * <ul>
 *   <li>{@link SimpleDateFormat} in shared state —&gt; {@code java.time} (DateTimeFormatter)</li>
 *   <li>raw {@code Map}/{@code List} (no generics) —&gt; parameterized types</li>
 *   <li>manual {@code null} checks —&gt; {@code Objects.requireNonNull} / {@code Optional}</li>
 * </ul>
 */
public class LegacyDateBucketUtil {

    // Outdated idiom 1: non-thread-safe SimpleDateFormat held in shared state.
    private static final SimpleDateFormat DAY_FORMAT = new SimpleDateFormat("yyyy-MM-dd");

    /**
     * Buckets dates by day, returning a map from "yyyy-MM-dd" to the count of dates that
     * fall on that day.
     *
     * Outdated idiom 2: raw Map (no generics).
     */
    public Map bucketByDay(List dates) {
        // Outdated idiom 3: manual null check.
        if (dates == null) {
            return new HashMap();
        }
        Map buckets = new HashMap();
        for (int i = 0; i < dates.size(); i++) {
            Object value = dates.get(i);
            if (value == null) {
                continue;
            }
            String key = DAY_FORMAT.format((Date) value);
            Integer existing = (Integer) buckets.get(key);
            // Outdated idiom 3 (again): manual null-or-default.
            buckets.put(key, existing == null ? Integer.valueOf(1) : Integer.valueOf(existing.intValue() + 1));
        }
        return buckets;
    }

    /**
     * Formats a date, tolerating a null input by returning "unknown".
     *
     * Outdated idiom 3 (again): manual null check / nullable return.
     */
    public String formatOrUnknown(Date date) {
        if (date == null) {
            return "unknown";
        }
        return DAY_FORMAT.format(date);
    }

    /**
     * Parses a day string, returning null on failure instead of propagating.
     *
     * Outdated idiom 1 (again): SimpleDateFormat.
     */
    public Date parseDayOrNull(String text) {
        if (text == null) {
            return null;
        }
        try {
            return DAY_FORMAT.parse(text);
        } catch (ParseException e) {
            return null;
        }
    }

    /**
     * Aggregates amounts keyed by bucket name.
     *
     * Outdated idiom 2: raw List + raw Map, manual null defaults.
     */
    public Map sumByBucket(List pairs) {
        Map totals = new HashMap();
        for (int i = 0; i < pairs.size(); i++) {
            List pair = (List) pairs.get(i);
            String bucket = (String) pair.get(0);
            Double amount = (Double) pair.get(1);
            Double current = (Double) totals.get(bucket);
            totals.put(bucket, (current == null ? 0.0d : current) + (amount == null ? 0.0d : amount));
        }
        return totals;
    }
}
