# Test Heuristics for Migration

## Use a Plain JUnit 5 Test When

- The legacy class is a utility, parser, formatter, or model transformation.
- Behavior is pure or mostly pure logic.

## Use Mockito-backed Unit Tests When

- The class has collaborators but no framework behavior needs to be exercised.
- You only need to verify branching, mapping, or delegation.

## Use `@WebMvcTest` When

- The migrated file is a controller.
- You need to verify request mapping, validation, status codes, or payload shapes.
- Full application startup is unnecessary.

## Use `@SpringBootTest` When

- The behavior under test depends on Spring wiring, configuration properties, or multiple layers working together.
- Narrower tests would miss the relevant behavior.

## Migration Rule of Thumb

- Start with the narrowest test that proves the behavior.
- Move to broader integration only when the narrower test is not credible.
