# Common Legacy-to-Spring-Boot Mappings

## Web and Endpoint Layers

- JAX-RS `@Path` resource -> Spring `@RestController` with `@RequestMapping`, `@GetMapping`, `@PostMapping`, etc.
- `Application` subclass with `@ApplicationPath` -> `@SpringBootApplication` entry point plus controller classes.
- `ExceptionMapper<T>` or `@Provider` handler -> `@RestControllerAdvice` with `@ExceptionHandler`.
- `HttpServlet` -> `@RestController` or `@Controller` depending on rendered output.
- `Filter` / servlet filter -> `OncePerRequestFilter` or Spring MVC interceptor.

## DI and Services

- EJB `@Stateless` / `@Singleton` -> Spring `@Service` or `@Component`.
- Legacy `@Inject` / container lookup -> constructor injection in Spring.
- XML bean wiring -> `@Configuration` + `@Bean` or component scanning.

## Configuration

- `web.xml` init params -> `application.yml` or `application.properties` + `@Value` or `@ConfigurationProperties`.
- JNDI lookup -> Spring-managed bean or property-backed configuration.
- Container-managed servlet setup -> Spring Boot auto-configuration.

## Testing

- JUnit 4 -> JUnit 5.
- Servlet/controller behavior -> `@WebMvcTest` when controller semantics matter.
- Service logic -> plain unit test with Mockito as needed.
- End-to-end app behavior -> `@SpringBootTest` only when narrower tests are insufficient.
