# Maple Street Receptionist

Phase 1 of the ProcIndex take-home: a text-based AI receptionist for a dog grooming shop.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The server listens on `http://localhost:3000`. Check it with:

```bash
curl http://localhost:3000/health
```

## Commands

- `npm run dev` starts the development server with reloads.
- `npm run build` compiles TypeScript into `dist/`.
- `npm start` runs the compiled server.
- `npm test` runs the tests.
- `npm run check` runs formatting, linting, type checking, and tests.

## Current structure

- `src/config/` contains explicit shop rules and values.
- `src/http/` contains the HTTP boundary.
- `.agents/skills/program-flow/references/requirements.md` contains the agreed behavior.

Domain objects, use cases, and external adapters will be added only when their behavior is implemented.
