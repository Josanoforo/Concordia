# Development tools

The project is implemented in TypeScript for Node.js. Dependencies and versions are locked in `package-lock.json`; use `npm ci` for a clean install. The standard checks are `npm run typecheck` and `npm test`.

A coding assistant was used during development, with human review of changes. The assistant is not a runtime dependency. Tests and the synthetic sample mode run locally without service credentials. Live integrations require separately configured local credentials and are not exercised by the public offline fixture.