package com.acme.legacy.customer;

import static org.junit.Assert.assertEquals;

import java.text.ParseException;
import java.text.SimpleDateFormat;

import org.junit.Test;

public class LegacyCustomerKeyServiceTest {

    private final SimpleDateFormat inputDateFormat = new SimpleDateFormat("yyyy-MM-dd");

    @Test
    public void shouldBuildCustomerKeyWithConfiguredPrefixAndTier() throws ParseException {
        LegacyCustomerRecord record = new LegacyCustomerRecord();
        record.setFirstName(" Anna ");
        record.setLastName("Smith");
        record.setRegionCode("ne");
        record.setSignupDate(inputDateFormat.parse("2014-03-15"));
        record.putAttribute("tier", " gold ");

        LegacyCustomerKeyService service =
                new LegacyCustomerKeyService(new PropertiesRegionCodeResolver());

        assertEquals("NEA-smith-anna-20140315-GOLD", service.buildCustomerKey(record));
    }

    @Test
    public void shouldUseDefaultsForUnknownRegionAndBlankNames() throws ParseException {
        LegacyCustomerRecord record = new LegacyCustomerRecord();
        record.setFirstName(" ");
        record.setLastName(null);
        record.setRegionCode("xx");
        record.setSignupDate(inputDateFormat.parse("2018-11-07"));

        LegacyCustomerKeyService service =
                new LegacyCustomerKeyService(new PropertiesRegionCodeResolver());

        assertEquals("GEN-unknown-unknown-20181107", service.buildCustomerKey(record));
    }
}
