# Legacy Framework Classifier

Inventory classification is governed by the stack pack's structured `classification.yaml` contract. This prose file is only an operator-facing explanation; the YAML is the executable vocabulary.

## Required semantics

- **Artifact role** is one of the registry roles: `rest-endpoint`, `exception-handler`, `startup-config`, `filter`, `service`, `utility`, `model`, `test`, `module`, `entry-point`, `transformer`, `interface`.
- **Detected framework** is a canonical legacy/source technology identifier from `classification.yaml` such as `servlet`, `struts`, `jax-rs`, `spring-mvc`, `jpa`, `ejb`, `guice`, `junit`, `testng`, or `plain-java`.
- **Artifact module** is build/source-set ownership derived by `classification.yaml` `modules.source_roots`, not the Java package. Examples: `legacy/app/src/main/java/...` → `app`, `legacy/app/src/test/java/...` → `app-test`, `legacy/it-selenium/src/test/java/...` → `it-selenium-test`, `legacy/db-utils/src/main/java/...` → `db-utils`.
- **Migration destination** is not stored in `framework`; it is decided later by stack mappings / target planning.
- Do not invent framework strings. Normalize aliases through `classification.yaml`.
- Do not use `Java-EE` as a generic fallback. Use `plain-java` only when no configured framework evidence is present and include explicit negative evidence such as `negative-evidence: no configured framework signal matched` with confidence at or above the stack threshold.
- A project may be mostly `plain-java`; concentration alone is advisory. However, known framework imports/annotations/base classes/interfaces may never silently fall through to `plain-java`.
- When equal-precedence evidence points to multiple frameworks, set framework to `ambiguous` and include evidence for each competing signal.
- Lifecycle tags such as `analyzed` are not classification evidence. Use the structured batch classification evidence fields.

## Java signal examples

- Servlet subclass/API: `javax.servlet.http.HttpServlet`, `jakarta.servlet.http.HttpServlet`, `extends HttpServlet` → framework `servlet`, role `rest-endpoint`.
- Servlet filter: servlet `Filter` import or `implements Filter` → framework `servlet`, role `filter`.
- Struts: `org.apache.struts.action.Action`, `extends Action`, Struts action classes/config evidence → framework `struts`, role `rest-endpoint`.
- JAX-RS: `javax.ws.rs.*`, `jakarta.ws.rs.*`, `@Path`, HTTP method annotations → framework `jax-rs`, role `rest-endpoint`.
- Spring MVC: `@Controller`, `@RestController`, `@RequestMapping`, `@*Mapping`, Spring web annotation imports → framework `spring-mvc`, role `rest-endpoint`.
- JPA/Hibernate persistence: `@Entity`, `@Embeddable`, `@MappedSuperclass`, `javax/jakarta.persistence.*` → framework `jpa`, role `model`; Spring Data repository interfaces → framework `jpa`, role `interface`.
- EJB: `@Stateless`, `@Stateful`, `@Singleton`, `@MessageDriven`, `javax/jakarta.ejb.*` → framework `ejb`, role `service`.
- Guice: `com.google.inject.*`, `AbstractModule` → framework `guice`, role `module` or `service` depending on the artifact.
- Tests: JUnit/TestNG imports/annotations → framework `junit` or `testng`, role `test`.
- No configured framework evidence → framework `plain-java`, role inferred from source shape/path.
