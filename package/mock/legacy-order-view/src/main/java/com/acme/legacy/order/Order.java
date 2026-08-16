package com.acme.legacy.order;

import java.util.Date;
import java.util.HashMap;
import java.util.Map;

/**
 * Mutable order record used by the legacy order view module.
 *
 * Intentionally dated: raw {@code Map} for attributes, {@code java.util.Date} for
 * timestamps, mutable JavaBean accessors.
 */
public class Order {

    private String orderId;
    private String customerId;
    private String productCode;
    private int quantity;
    private double unitPrice;
    private int stockOnHand;
    private Date placedAt;
    private Map attributes = new HashMap();

    public String getOrderId() {
        return orderId;
    }

    public void setOrderId(String orderId) {
        this.orderId = orderId;
    }

    public String getCustomerId() {
        return customerId;
    }

    public void setCustomerId(String customerId) {
        this.customerId = customerId;
    }

    public String getProductCode() {
        return productCode;
    }

    public void setProductCode(String productCode) {
        this.productCode = productCode;
    }

    public int getQuantity() {
        return quantity;
    }

    public void setQuantity(int quantity) {
        this.quantity = quantity;
    }

    public double getUnitPrice() {
        return unitPrice;
    }

    public void setUnitPrice(double unitPrice) {
        this.unitPrice = unitPrice;
    }

    public int getStockOnHand() {
        return stockOnHand;
    }

    public void setStockOnHand(int stockOnHand) {
        this.stockOnHand = stockOnHand;
    }

    public Date getPlacedAt() {
        return placedAt;
    }

    public void setPlacedAt(Date placedAt) {
        this.placedAt = placedAt;
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
