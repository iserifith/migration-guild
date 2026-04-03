# Legacy Framework Classification to Spring Boot Strategy

## JAX-RS / Jersey

- Signals: `javax.ws.rs.*`, `jakarta.ws.rs.*`, `@Path`, `@GET`, `@POST`, `Application`, `ExceptionMapper`
- Spring Boot destination: `@RestController`, Spring MVC request mappings, `@RestControllerAdvice`

## Servlet-based Applications

- Signals: `HttpServlet`, `Filter`, `ServletContextListener`, `web.xml`
- Spring Boot destination: controller, `OncePerRequestFilter`, listener/config bean, `application.yml`

## EJB-based Applications

- Signals: `@Stateless`, `@Singleton`, `@MessageDriven`, local/remote interfaces, `ejb-jar.xml`
- Spring Boot destination: `@Service`, event/message abstraction, Java config

## Struts / Action-based MVC

- Signals: Struts actions, `struts.xml`, action mappings, form beans
- Spring Boot destination: controller + request DTO + validation + service layer

## Old Spring MVC / XML-heavy Spring

- Signals: `@Controller`, legacy `ModelAndView`, XML bean config, `DispatcherServlet` setup in XML
- Spring Boot destination: Spring Boot controller/service/configuration classes, Java config, auto-configuration
