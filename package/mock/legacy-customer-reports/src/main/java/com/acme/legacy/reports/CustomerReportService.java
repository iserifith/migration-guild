package com.acme.legacy.reports;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;

import com.acme.legacy.customer.LegacyCustomerKeyService;
import com.acme.legacy.customer.LegacyCustomerRecord;
import com.acme.legacy.customer.RegionCodeResolver;

import org.apache.commons.lang.StringUtils;
import org.apache.log4j.Logger;

/**
 * Legacy reporting service that DEPENDS on {@code legacy-customer-utils}.
 *
 * It imports and calls {@link LegacyCustomerKeyService} to build a per-customer key and
 * then aggregates several records into a plain-text report. The import is a REAL
 * compile-time edge: when both fixture source trees are inventoried together, the scanner
 * records a source dependency from this module to {@code legacy-customer-utils}, which the
 * planner must satisfy by ordering the dependency into an earlier wave (Spec 008, US2).
 *
 * Intentionally dated: {@code SimpleDateFormat}, raw {@code List}, string concatenation,
 * Java 7 bytecode target.
 */
public class CustomerReportService {

    private static final Logger LOGGER = Logger.getLogger(CustomerReportService.class);

    private static final SimpleDateFormat REPORT_DATE_FORMAT = new SimpleDateFormat("yyyy-MM-dd");

    private final LegacyCustomerKeyService keyService;

    public CustomerReportService(RegionCodeResolver regionCodeResolver) {
        if (regionCodeResolver == null) {
            throw new IllegalArgumentException("regionCodeResolver is required");
        }
        this.keyService = new LegacyCustomerKeyService(regionCodeResolver);
    }

    public String buildReport(List records) throws ParseException {
        if (records == null || records.isEmpty()) {
            return "No customers to report.";
        }

        StringBuffer report = new StringBuffer();
        report.append("CUSTOMER REPORT\n");
        report.append("----------------\n");
        for (int i = 0; i < records.size(); i++) {
            LegacyCustomerRecord record = (LegacyCustomerRecord) records.get(i);
            String key = keyService.buildCustomerKey(record);
            String name = StringUtils.trimToEmpty(record.getFirstName()) + " "
                    + StringUtils.trimToEmpty(record.getLastName());
            report.append(key);
            report.append(" : ");
            report.append(name);
            if (record.getSignupDate() != null) {
                report.append(" (since ");
                report.append(REPORT_DATE_FORMAT.format(record.getSignupDate()));
                report.append(")");
            }
            report.append("\n");
        }
        return report.toString();
    }

    public List buildKeys(List records) {
        if (records == null) {
            return new ArrayList();
        }
        List keys = new ArrayList();
        for (int i = 0; i < records.size(); i++) {
            keys.add(keyService.buildCustomerKey((LegacyCustomerRecord) records.get(i)));
        }
        return keys;
    }
}
