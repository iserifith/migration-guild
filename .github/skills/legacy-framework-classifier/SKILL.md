---
name: legacy-framework-classifier
description: "Classify a legacy Java module or file by detecting framework signals from imports, annotations, XML descriptors, and packaging. Use for JAX-RS, Struts, EJB, Spring MVC 4.x, servlets, XML-configured apps, and mixed legacy stacks before migration planning."
argument-hint: "Path to a legacy Java file or module root to classify"
---

# Legacy Framework Classifier

Use this skill when you need to determine what kind of legacy Java application you are looking at before choosing a migration strategy.

## When to Use

- A workspace contains only legacy code and the framework is unknown.
- You need to decide whether a file should become a controller, service, filter, config class, or test in the target framework.
- You need to inspect XML descriptors such as `web.xml`, `applicationContext.xml`, `struts.xml`, or `ejb-jar.xml`.

## Signals to Check

- Imports: `javax.ws.rs`, `jakarta.ws.rs`, `javax.ejb`, `javax.servlet`, `org.apache.struts`, old `org.springframework.web.*`
- Annotations: `@Path`, `@ApplicationPath`, `@Stateless`, `@WebServlet`, `@Controller`, `@RequestMapping`
- XML descriptors and config files: `web.xml`, `applicationContext.xml`, `struts.xml`, `ejb-jar.xml`
- Packaging and build signals: WAR packaging, servlet containers, EAR modules, old Spring XML config

## Procedure

1. Read the target file and record imports, annotations, base classes, and interfaces.
2. Search the module for XML descriptors and framework configuration files.
3. Classify the file role:
   - REST endpoint
   - servlet or filter
   - service bean
   - exception handler
   - startup/config
   - utility
   - model
   - test
4. Map the detected framework to a target migration strategy using [migration mappings](./references/common-mappings.md).
5. Produce a short report with:
   - detected framework
   - file role
   - likely target destination type
   - complexity
   - required tests-first strategy

## Output Checklist

- Detected framework is explicit.
- File role is explicit.
- Target destination type is explicit.
- Configuration dependencies are listed.
- Test-first recommendation is included.
