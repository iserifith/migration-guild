package com.acme.legacy.order;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

/**
 * Legacy-side test for the order view module. Mirrors the
 * {@code LegacyCustomerKeyServiceTest} JUnit 4 pattern so a migrated equivalent
 * (contract-backed endpoint + extracted {@code *Validator}/{@code *Service}) has a
 * behavior baseline to check against.
 */
public class OrderViewActionTest {

    @Test
    public void viewPathRejectsBlankCustomerId() {
        OrderViewAction action = new OrderViewAction();
        Order order = new Order();
        order.setProductCode("WIDGET-1");
        order.setQuantity(3);
        order.setUnitPrice(9.99d);
        order.setStockOnHand(50);

        List errors = action.validateOrder(order);
        assertTrue(errors.contains("Customer id is required"));
    }

    @Test
    public void viewPathRejectsShortProductCode() {
        OrderViewAction action = new OrderViewAction();
        Order order = new Order();
        order.setCustomerId("C-1");
        order.setProductCode("AB");
        order.setQuantity(3);
        order.setUnitPrice(9.99d);
        order.setStockOnHand(50);

        List errors = action.validateOrder(order);
        assertTrue(errors.contains("Product code must be at least 4 characters"));
    }

    @Test
    public void validOrderHasNoValidationErrors() {
        OrderViewAction action = new OrderViewAction();
        Order order = validOrder();

        List errors = action.validateOrder(order);
        assertTrue("expected no validation errors for a valid order", errors.isEmpty());
    }

    @Test
    public void bulkQuantityAppliesTenPercentDiscount() {
        OrderViewAction action = new OrderViewAction();
        Order order = validOrder();
        order.setQuantity(20); // >= bulk threshold
        order.setUnitPrice(10.00d);

        double total = action.calculateOrderTotal(order);
        // 20 * 10 = 200; -10% = 180
        assertEquals(180.00d, total, 0.0001d);
    }

    @Test
    public void expediteFlagAddsSurcharge() {
        OrderViewAction action = new OrderViewAction();
        Order order = validOrder();
        order.setQuantity(5);
        order.setUnitPrice(10.00d);
        order.putAttribute("expedite", "true");

        double total = action.calculateOrderTotal(order);
        // 5 * 10 = 50; + 12.50 surcharge = 62.50
        assertEquals(62.50d, total, 0.0001d);
    }

    @Test
    public void insufficientStockIsDetected() {
        OrderViewAction action = new OrderViewAction();
        Order order = validOrder();
        order.setQuantity(5);
        order.setUnitPrice(10.00d);
        order.setStockOnHand(2); // below requested quantity

        assertFalse(action.isStockSufficient(order));
    }

    @Test
    public void orderLabelIncludesProductAndQuantity() {
        OrderViewAction action = new OrderViewAction();
        Order order = validOrder();
        order.setProductCode("widget-1");

        String label = action.buildOrderLabel(order);
        assertTrue(label.startsWith("WIDGET-1-5"));
    }

    private Order validOrder() {
        Order order = new Order();
        order.setCustomerId("C-1");
        order.setProductCode("WIDGET-1");
        order.setQuantity(5);
        order.setUnitPrice(10.00d);
        order.setStockOnHand(50);
        return order;
    }
}
