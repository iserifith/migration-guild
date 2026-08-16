package com.acme.legacy.bait;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/**
 * Legacy-side test for the bait utility. Mirrors the
 * {@code LegacyCustomerKeyServiceTest} JUnit 4 pattern. It pins the legacy behavior so a
 * modernization (or a future detection rule) has a baseline to compare against
 * (Spec 008, US3).
 */
public class LegacyDateBucketUtilTest {

    private final SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd");

    private LegacyDateBucketUtil util() {
        return new LegacyDateBucketUtil();
    }

    @Test
    public void bucketsDatesByDayWithCounts() throws Exception {
        List dates = new ArrayList();
        dates.add(fmt.parse("2024-01-01"));
        dates.add(fmt.parse("2024-01-01"));
        dates.add(fmt.parse("2024-01-02"));

        Map buckets = util().bucketByDay(dates);

        assertEquals(Integer.valueOf(2), buckets.get("2024-01-01"));
        assertEquals(Integer.valueOf(1), buckets.get("2024-01-02"));
        assertEquals(2, buckets.size());
    }

    @Test
    public void nullDateListReturnsEmptyMap() {
        Map buckets = util().bucketByDay(null);
        assertTrue(buckets.isEmpty());
    }

    @Test
    public void formatOrUnknownToleratesNull() {
        assertEquals("unknown", util().formatOrUnknown(null));
        assertEquals("2024-01-01", util().formatOrUnknown(new Date(0))); // epoch == 1970-01-01
    }

    @Test
    public void parseDayOrNullToleratesBadInput() {
        assertNull(util().parseDayOrNull(null));
        assertNull(util().parseDayOrNull("not-a-date"));
        assertEquals("2024-01-01", util().formatOrUnknown(util().parseDayOrNull("2024-01-01")));
    }

    @Test
    public void sumsAmountsByBucket() {
        List pairs = new ArrayList();
        List a1 = new ArrayList();
        a1.add("north");
        a1.add(Double.valueOf(10.0d));
        List a2 = new ArrayList();
        a2.add("north");
        a2.add(Double.valueOf(5.0d));
        List a3 = new ArrayList();
        a3.add("south");
        a3.add(Double.valueOf(2.0d));
        pairs.add(a1);
        pairs.add(a2);
        pairs.add(a3);

        Map totals = util().sumByBucket(pairs);
        assertEquals(Double.valueOf(15.0d), totals.get("north"));
        assertEquals(Double.valueOf(2.0d), totals.get("south"));
    }
}
