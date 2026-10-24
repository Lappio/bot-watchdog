# bot-watchdog dashboard

Independent Vite + React + TypeScript app, styled with Tailwind v4 and shadcn/ui.
See the repository README's Dashboard section for setup, authentication, and component details.

```sh
npm ci
npm run dev       # proxy Worker routes to 127.0.0.1:8787
npm run typecheck
npm test
npm run build     # dist/dashboard, base /dashboard/
```

Start Wrangler separately from the repository root. Open `/dashboard/` at the Vite
URL for development, or http://localhost:8787/dashboard/ after a build.
