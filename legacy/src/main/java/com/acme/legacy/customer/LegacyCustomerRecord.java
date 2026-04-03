package com.acme.legacy.customer;

import java.util.Date;
import java.util.HashMap;
import java.util.Map;

public class LegacyCustomerRecord {

    private String id;
    private String firstName;
    private String lastName;
    private String regionCode;
    private Date signupDate;
    private Map attributes = new HashMap();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getFirstName() {
        return firstName;
    }

    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    public String getLastName() {
        return lastName;
    }

    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    public String getRegionCode() {
        return regionCode;
    }

    public void setRegionCode(String regionCode) {
        this.regionCode = regionCode;
    }

    public Date getSignupDate() {
        return signupDate;
    }

    public void setSignupDate(Date signupDate) {
        this.signupDate = signupDate;
    }

    public Map getAttributes() {
        return attributes;
    }

    public void setAttributes(Map attributes) {
        this.attributes = attributes;
    }

    public Object getAttribute(String key) {
        return attributes.get(key);
    }

    public void putAttribute(String key, Object value) {
        attributes.put(key, value);
    }
}
