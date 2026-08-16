package com.acme.legacy.order;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.apache.commons.lang.StringUtils;
import org.apache.log4j.Logger;
import org.apache.struts.action.Action;
import org.apache.struts.action.ActionForm;
import org.apache.struts.action.ActionForward;
import org.apache.struts.action.ActionMapping;

/**
 * Legacy Struts action that serves TWO request paths for the order screen:
 *
 * <ul>
 *   <li>{@code /order/view}   — renders the order summary into order-view.jsp</li>
 *   <li>{@code /order/submit} — validates and books the order, then re-renders</li>
 * </ul>
 *
 * Both paths run the SAME validation rules and the SAME pricing/stock business rules,
 * inline in this view-handling class. That is the point of this fixture: a correct
 * migration must extract the shared validation into ONE named {@code *Validator}
 * module and the shared pricing/stock rules into ONE named {@code *Service} module
 * (never duplicated per-endpoint, never left inline in the handler), and must expose
 * the surface as an API contract with no JSP/Struts residue.
 *
 * Intentionally dated: Struts 1.x {@code Action}, servlet 2.4, {@code SimpleDateFormat}
 * in shared state, raw collections, string-concatenated view routing.
 */
public class OrderViewAction extends Action {

    private static final Logger LOGGER = Logger.getLogger(OrderViewAction.class);

    private static final SimpleDateFormat PLACED_AT_FORMAT = new SimpleDateFormat("yyyyMMdd-HHmm");

    private static final double BULK_DISCOUNT_RATE = 0.10d;
    private static final int BULK_DISCOUNT_MIN_QUANTITY = 10;
    private static final double EXPEDITE_SURCHARGE = 12.50d;

    public ActionForward execute(ActionMapping mapping, ActionForm form,
            HttpServletRequest request, HttpServletResponse response) {

        Order order = readOrderFromRequest(request);
        String path = mapping.getPath();

        // ---- Request path 1: view -------------------------------------------------
        if (path != null && path.endsWith("/view")) {
            List errors = validateOrder(order);
            if (!errors.isEmpty()) {
                request.setAttribute("errors", errors);
                return mapping.findForward("failure");
            }
            request.setAttribute("orderTotal", new Double(calculateOrderTotal(order)));
            request.setAttribute("orderLabel", buildOrderLabel(order));
            return mapping.findForward("success");
        }

        // ---- Request path 2: submit ----------------------------------------------
        if (path != null && path.endsWith("/submit")) {
            // Same validation rules as the view path.
            List errors = validateOrder(order);
            if (!errors.isEmpty()) {
                request.setAttribute("errors", errors);
                return mapping.findForward("failure");
            }
            // Same pricing/stock business rules as the view path.
            if (!isStockSufficient(order)) {
                errors.add("Insufficient stock for product " + order.getProductCode());
                request.setAttribute("errors", errors);
                return mapping.findForward("failure");
            }
            double total = calculateOrderTotal(order);
            order.putAttribute("bookedTotal", new Double(total));
            request.setAttribute("orderTotal", new Double(total));
            request.setAttribute("orderLabel", buildOrderLabel(order));
            LOGGER.info("Booked order " + order.getOrderId() + " for " + total);
            return mapping.findForward("success");
        }

        LOGGER.warn("Unmapped order path: " + path);
        return mapping.findForward("failure");
    }

    // ---------------------------------------------------------------------------
    // Validation logic — inline in the view handler on purpose.
    // A correct migration consolidates this into ONE named *Validator module.
    // ---------------------------------------------------------------------------
    List validateOrder(Order order) {
        List errors = new ArrayList();
        if (order == null) {
            errors.add("Order is required");
            return errors;
        }
        if (StringUtils.isBlank(order.getCustomerId())) {
            errors.add("Customer id is required");
        }
        if (StringUtils.isBlank(order.getProductCode())) {
            errors.add("Product code is required");
        } else if (order.getProductCode().length() < 4) {
            errors.add("Product code must be at least 4 characters");
        }
        if (order.getQuantity() <= 0) {
            errors.add("Quantity must be greater than zero");
        }
        if (order.getQuantity() > 500) {
            errors.add("Quantity must not exceed 500 per order");
        }
        if (order.getUnitPrice() <= 0d) {
            errors.add("Unit price must be greater than zero");
        }
        return errors;
    }

    // ---------------------------------------------------------------------------
    // Business rules — inline in the view handler on purpose.
    // A correct migration consolidates these into ONE named *Service module.
    // ---------------------------------------------------------------------------
    double calculateOrderTotal(Order order) {
        double total = order.getQuantity() * order.getUnitPrice();
        if (order.getQuantity() >= BULK_DISCOUNT_MIN_QUANTITY) {
            total = total - (total * BULK_DISCOUNT_RATE);
        }
        Object expedite = order.getAttribute("expedite");
        if (expedite != null && "true".equalsIgnoreCase(expedite.toString())) {
            total = total + EXPEDITE_SURCHARGE;
        }
        return Math.round(total * 100.0d) / 100.0d;
    }

    boolean isStockSufficient(Order order) {
        return order.getStockOnHand() >= order.getQuantity();
    }

    String buildOrderLabel(Order order) {
        StringBuffer label = new StringBuffer();
        label.append(StringUtils.upperCase(StringUtils.trimToEmpty(order.getProductCode())));
        label.append("-");
        label.append(order.getQuantity());
        if (order.getPlacedAt() != null) {
            label.append("-");
            label.append(PLACED_AT_FORMAT.format(order.getPlacedAt()));
        }
        return label.toString();
    }

    private Order readOrderFromRequest(HttpServletRequest request) {
        Order order = new Order();
        order.setOrderId(request.getParameter("orderId"));
        order.setCustomerId(request.getParameter("customerId"));
        order.setProductCode(request.getParameter("productCode"));
        order.setQuantity(parseInt(request.getParameter("quantity")));
        order.setUnitPrice(parseDouble(request.getParameter("unitPrice")));
        order.setStockOnHand(parseInt(request.getParameter("stockOnHand")));
        order.setPlacedAt(new Date());
        order.putAttribute("expedite", request.getParameter("expedite"));
        return order;
    }

    private int parseInt(String value) {
        if (StringUtils.isBlank(value)) {
            return 0;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            LOGGER.warn("Unparseable int: " + value);
            return 0;
        }
    }

    private double parseDouble(String value) {
        if (StringUtils.isBlank(value)) {
            return 0d;
        }
        try {
            return Double.parseDouble(value.trim());
        } catch (NumberFormatException e) {
            LOGGER.warn("Unparseable double: " + value);
            return 0d;
        }
    }
}
