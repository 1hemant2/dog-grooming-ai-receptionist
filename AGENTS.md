# Code Quality Guidelines

Write code for a human reviewer. Optimize for clarity, correctness, maintainability, and ease of explanation.

## Low-level design

- Identify responsibilities, domain objects, boundaries, and data flow before implementing a non-trivial feature.
- Keep each class or module focused on one cohesive responsibility.
- Keep domain logic independent from frameworks, transport layers, databases, and third-party SDKs.
- Place side effects behind small interfaces so core behavior can be tested without external systems.
- Make dependencies explicit through constructors or function parameters. Avoid hidden dependencies and global mutable state.
- Read environment variables in one application configuration module. Other modules should use the parsed configuration instead of accessing `process.env` directly.
- Model important domain concepts with meaningful types instead of passing unrelated primitive values everywhere.
- Keep public APIs small. Expose only the operations a caller needs.
- Represent expected failures explicitly and handle errors at the correct boundary.
- Keep control flow straightforward. Prefer early returns over deep nesting.

## Object-oriented design

- Use classes when an object owns state, behavior, identity, or invariants. Use functions for simple stateless transformations.
- Keep behavior close to the data and rules it protects.
- Apply SOLID principles pragmatically; do not introduce abstractions only to demonstrate a principle.
- Prefer composition over inheritance.
- Depend on interfaces at external boundaries, not on concrete SDK clients throughout the codebase.
- Keep interfaces small and cohesive. Do not create an interface when there is no useful boundary or alternate implementation.
- Enforce valid state when objects are created instead of scattering validation across callers.
- Avoid god classes, anemic domain models, long parameter lists, and boolean flags that change a method's meaning.
- Use design patterns only when they simplify a real problem. Do not add factories, repositories, strategies, or builders by default.

## Readability

- Use descriptive names that reflect business meaning. Avoid vague names such as `data`, `item`, `manager`, `helper`, or `utils` when a precise name exists.
- Keep functions short enough to understand as one unit, but do not split simple logic into trivial wrappers.
- Keep one level of abstraction within a function.
- Replace magic values with named constants or domain types.
- Prefer explicit code over clever expressions and premature generalization.
- Prefer common, widely recognized language syntax when a straightforward option exists.
- Avoid advanced or uncommon syntax that makes code harder to review, explain, or maintain. Use it only when it provides a clear benefit that simpler syntax cannot provide.
- Prefer direct calls and named functions for normal control flow. Use callbacks when an API or event requires them, and keep non-trivial callback behavior in a clearly named function.
- Write comments to explain why a decision exists, not to repeat what the code says.
- Follow the language's standard formatting and naming conventions consistently.

## Simplicity

- Implement the smallest design that satisfies the current requirement.
- Do not add speculative features, unused extension points, or placeholder layers.
- Avoid generated boilerplate, unnecessary wrappers, and duplicated data models.
- Extract shared code only when duplication is real or a clear boundary exists.
- Add a dependency only when it materially reduces complexity or provides a capability that should not be maintained locally.
- Remove dead code, unused imports, debugging output, and obsolete comments before finishing.

## Verification

- Test observable behavior through public APIs rather than private implementation details.
- Cover important success paths, edge cases, invalid input, and failure behavior.
- Keep tests readable and deterministic. Mock only external boundaries.
- Run the formatter, linter, type checker, and relevant tests after meaningful changes.
- Review the final diff for unnecessary complexity, accidental changes, secrets, and unclear naming.
- Every committed line must be understandable and defensible during review.
