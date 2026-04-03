package com.acme.legacy.customer;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

import org.apache.commons.lang.StringUtils;
import org.apache.log4j.Logger;

public class PropertiesRegionCodeResolver implements RegionCodeResolver {

    private static final Logger LOGGER = Logger.getLogger(PropertiesRegionCodeResolver.class);

    private final Properties properties = new Properties();

    public PropertiesRegionCodeResolver() {
        InputStream in = Thread.currentThread().getContextClassLoader()
                .getResourceAsStream("region-prefixes.properties");
        if (in == null) {
            throw new IllegalStateException("Missing region-prefixes.properties");
        }

        try {
            properties.load(in);
        } catch (IOException e) {
            throw new IllegalStateException("Unable to load region-prefixes.properties", e);
        } finally {
            try {
                in.close();
            } catch (IOException e) {
                LOGGER.warn("Unable to close region-prefixes.properties stream", e);
            }
        }
    }

    public String resolvePrefix(String regionCode) {
        String normalized = StringUtils.upperCase(StringUtils.trimToEmpty(regionCode));
        String prefix = properties.getProperty(normalized);
        if (StringUtils.isBlank(prefix)) {
            return "GEN";
        }
        return prefix;
    }
}
