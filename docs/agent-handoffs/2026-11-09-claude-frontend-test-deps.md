# Frontend component-test dependencies

- **From → To:** claude → integration
- **Type:** protected-file-change
- **Status:** proposed
- **Branch / PR:** claude/awesome-turing-2fh5e7
- **Blocking?:** no (interaction tests for components are limited until approved)

## Need
Frontend tests currently run in the Node environment with no DOM. State logic is tested via pure
reducers/actions and markup via `react-dom/server`, but interactive flows (clicks, keyboard, focus,
`aria-live` updates) cannot be exercised without a DOM and Testing Library.

## Proposed change
`package.json` devDependencies:

```json
"@testing-library/react": "^16",
"@testing-library/user-event": "^14",
"@testing-library/jest-dom": "^6",
"jsdom": "^25"
```

`vitest.config.ts`:

```ts
test: {
  include: ["tests/backend/**/*.test.ts", "tests/frontend/**/*.test.{ts,tsx}"],
  environmentMatchGlobs: [["tests/frontend/**", "jsdom"]],
}
```

## Impact
Only test tooling. No runtime or bundle change. Backend tests keep the Node environment.

## Approvals
- [ ] Codex
- [x] Claude
- [ ] Integration owner

## Also: CSS in Vitest
Vitest fails to load `postcss.config.mjs` (`Invalid PostCSS Plugin found at: plugins[0]`) when a test
imports a component that uses a CSS module. Please add `css: { postcss: {} }` (or an equivalent override)
to `vitest.config.ts`, plus `esbuild: { jsx: "automatic" }` (JSX in components currently compiles with the classic runtime, so tests set a global `React`). Until then, frontend tests `vi.mock()` the feature style modules.
