# Common Legacy-to-Spring-Boot Mappings

- JAX-RS resources become Spring MVC REST controllers; exception mappers become controller advice.
- Servlets become controllers; servlet filters become `OncePerRequestFilter` or interceptors.
- EJB service beans become Spring services/components with constructor injection.
- Struts actions become controllers, request DTOs, validation, and services.
- XML bean wiring becomes configuration classes, beans, or component scanning.
- JUnit 4 tests become JUnit 5 tests; prefer narrow MVC or unit tests over full-context tests.
