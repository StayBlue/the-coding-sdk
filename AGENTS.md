# AGENTS.md

Use Bun for development workflows.

- Prefer `bun`, `bun run`, `bun test`, `bun build`, `bun install`, and `bunx`
- Do not use Node-specific toolchains when Bun provides the equivalent

Runtime compatibility matters.

- Keep the published library compatible with Node
- In repo-local scripts and dev tooling, prefer Bun APIs when practical
- Do not introduce Bun-specific runtime dependencies into the published library surface
- Prefer `Bun.file`, `Bun.$`, and Bun's test runner in scripts and tooling over Node-specific alternatives when compatibility is not required

Repo-specific notes.

- Use `oxlint` and `oxfmt`, not ESLint or Prettier
- Build JS with Bun and types with `tsc`
- Keep package exports aligned for the main entrypoint and `./sdk-tools`

Before finishing changes, run the relevant checks.

- Usually: `bun run lint`, `bun run typecheck`, and `bun test`
- If API or docs changed: `bun run api-surface:check` and `bun run docs:check`
