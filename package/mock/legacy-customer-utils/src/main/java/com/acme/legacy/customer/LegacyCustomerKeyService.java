package com.acme.legacy.customer;

import java.text.SimpleDateFormat;

import org.apache.commons.lang.StringUtils;

public class LegacyCustomerKeyService {

    private static final SimpleDateFormat SIGNUP_DATE_FORMAT = new SimpleDateFormat("yyyyMMdd");

    private final RegionCodeResolver regionCodeResolver;

    public LegacyCustomerKeyService(RegionCodeResolver regionCodeResolver) {
        if (regionCodeResolver == null) {
            throw new IllegalArgumentException("regionCodeResolver is required");
        }
        this.regionCodeResolver = regionCodeResolver;
    }

    public String buildCustomerKey(LegacyCustomerRecord record) {
        if (record == null) {
            throw new IllegalArgumentException("record is required");
        }
        if (record.getSignupDate() == null) {
            throw new IllegalArgumentException("signupDate is required");
        }

        StringBuffer key = new StringBuffer();
        key.append(regionCodeResolver.resolvePrefix(record.getRegionCode()));
        key.append("-");
        key.append(normalizeNamePart(record.getLastName()));
        key.append("-");
        key.append(normalizeNamePart(record.getFirstName()));
        key.append("-");
        key.append(SIGNUP_DATE_FORMAT.format(record.getSignupDate()));

        Object tier = record.getAttribute("tier");
        if (tier != null && StringUtils.isNotBlank(tier.toString())) {
            key.append("-");
            key.append(StringUtils.upperCase(StringUtils.trim(tier.toString())));
        }

        return key.toString();
    }

    private String normalizeNamePart(String value) {
        String normalized = StringUtils.trimToEmpty(value);
        normalized = StringUtils.lowerCase(normalized);
        normalized = StringUtils.deleteWhitespace(normalized);
        if (StringUtils.isBlank(normalized)) {
            return "unknown";
        }
        return normalized;
    }
}
