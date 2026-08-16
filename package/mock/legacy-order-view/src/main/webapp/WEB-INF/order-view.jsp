<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ page import="java.util.List" %>
<%@ taglib uri="http://struts.apache.org/tags-bean" prefix="bean" %>
<%@ taglib uri="http://struts.apache.org/tags-html" prefix="html" %>
<jsp:useBean id="orderLabel" class="java.lang.String" scope="request"/>
<jsp:useBean id="orderTotal" class="java.lang.Double" scope="request"/>
<jsp:useBean id="errors" class="java.util.List" scope="request"/>
<!DOCTYPE html>
<html>
<head><title>Order Summary</title></head>
<body>
<h1>Order: <%= orderLabel %></h1>
<%
  List errs = (List) request.getAttribute("errors");
  if (errs != null && !errs.isEmpty()) {
%>
  <ul class="errors">
  <% for (int i = 0; i < errs.size(); i++) { %>
    <li><%= errs.get(i) %></li>
  <% } %>
  </ul>
<%
  } else {
%>
  <p class="total">Total: <%= orderTotal %></p>
<%
  }
%>
<html:form action="/order/submit">
  <html:text property="productCode"/>
  <html:text property="quantity"/>
  <html:submit>Book order</html:submit>
</html:form>
</body>
</html>
