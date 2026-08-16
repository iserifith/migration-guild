package com.acme.legacy.reports;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;

import com.acme.legacy.customer.LegacyCustomerKeyService;
import com.acme.legacy.customer.LegacyCustomerRecord;
import com.acme.legacy.customer.PropertiesRegionCodeResolver;

import org.junit.Test;

/**
 * Legacy-side test for the customer report service. Mirrors the
 * {@code LegacyCustomerKeyServiceTest} JUnit 4 pattern. It proves the real compile-time
 * dependency on {@code legacy-customer-utils} resolves and behaves. (Spec 008, US2.)
 */
public class CustomerReportServiceTest {

    private final SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd");

    private CustomerReportService newService() {
        return new CustomerReportService(new PropertiesRegionCodeResolver());
    }

    @Test
    public void buildsReportAcrossMultipleRecords() throws ParseException {
        List records = new ArrayList();
        records.add(record("Anna", "Smith", "ne", "2014-03-15", "gold"));
        records.add(record("Bob", "Jones", "we", "2019-07-01", "silver"));

        String report = newService().buildReport(records);

        assertTrue(report.contains("CUSTOMER REPORT"));
        assertTrue(report.contains("NEA-smith-anna-20140315-GOLD"));
        assertTrue(report.contains("WEJ-jones-bob-20190701-SILVER"));
    }

    @Test
    public void emptyRecordsYieldEmptyReportMessage() throws ParseException {
        List records = new ArrayList();
        assertEquals("No customers to report.", newService().buildReport(records));
    }

    @Test
    public void buildsKeysForEachRecord() throws ParseException {
        List records = new ArrayList();
        records.add(record("Anna", "Smith", "ne", "2014-03-15", "gold"));
        records.add(record("Bob", "Jones", "we", "2019-07-01", "silver"));

        List keys = newService().buildKeys(records);
        assertEquals(2, keys.size());
        assertEquals("NEA-smith-anna-20140315-GOLD", keys.get(0));
        assertEquals("WEJ-jones-bob-20190701-SILVER", keys.get(1));
    }

    private LegacyCustomerRecord record(String first, String last, String region,
            String signup, String tier) throws ParseException {
        LegacyCustomerRecord record = new LegacyCustomerRecord();
        record.setFirstName(first);
        record.setLastName(last);
        record.setRegionCode(region);
        record.setSignupDate(dateFormat.parse(signup));
        record.putAttribute("tier", tier);
        return record;
    }
}
