# Feedback-to-Code

Implementación aislada del MVP descrito en `PRODUCT_SPEC.md`, con flujo vertical ejecutable:

```text
SDK Next.js → Fastify API → PostgreSQL/MinIO → BullMQ/Redis → clasificación → GitHub Issue → agente controlado → validaciones → Pull Request
```

El modo `mock` usa la infraestructura real y adaptadores deterministas para OpenAI y GitHub. El modo `real` usa OpenAI Responses API y una GitHub App; en ninguno de los dos existe merge automático ni push a la rama base.

## Quickstart con Docker

Requisitos: Docker con Compose, Node.js 22.6+ y pnpm 10.

```bash
cp .env.example .env
pnpm install
pnpm docker:up
pnpm demo:flow
```

Abre `http://localhost:3000`, pulsa **Feedback**, selecciona el botón azul y envía el comentario. La página mostrará la transición hasta `pr_opened`.

Servicios:

| Servicio | URL/puerto |
|---|---|
| Demo Next.js | `http://localhost:3000` |
| API | `http://localhost:3001` |
| MinIO API/console | `http://localhost:9000` / `http://localhost:9001` |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |

Comandos operativos:

```bash
pnpm docker:logs
pnpm docker:down
pnpm db:migrate
pnpm demo:flow
```

Los volúmenes se conservan al ejecutar `docker:down`. No uses los valores de `.env.example` en producción.

## Validación

```bash
pnpm lint
pnpm typecheck
pnpm test
RUN_DOCKER_E2E=true pnpm test:e2e
pnpm build
```

El E2E verifica ingestión idempotente, screenshot en MinIO, PostgreSQL, cola Redis, worker, Issue/PR mock, reporte de validación, métricas internas y borrado por `feedback_id`.

## Modos de integración

- `INTEGRATION_MODE=mock`: no necesita claves externas. Crea Issue y PR deterministas y modifica `tests/fixtures/repo-basic` dentro de un workspace efímero.
- `INTEGRATION_MODE=real`: requiere `OPENAI_API_KEY` y credenciales de una GitHub App. Clona el repositorio autorizado, crea una rama `feedback/*`, ejecuta sólo herramientas tipadas y scripts allowlisted, sube esa rama y abre un PR para revisión humana.

Consulta [configuración local](docs/local-development.md), [integración del SDK](docs/sdk-integration.md) y [GitHub App + OpenAI](docs/github-app.md).

## Organización

- `apps/api`: API de ingestión, estado, webhooks y operación interna.
- `apps/worker`: consumidor BullMQ y composición del agente.
- `packages/sdk`: cliente browser-safe, overlay React, selección, screenshot y redacción.
- `packages/db`, `queue`, `storage`: PostgreSQL, Redis/BullMQ y S3/MinIO.
- `packages/openai`, `github`: adaptadores mock y reales.
- `packages/agent`: workspace efímero, herramientas tipadas, validación, commit y PR.
- `demo-app`: aplicación Next.js separada que consume el SDK.
- `tests/fixtures/repo-basic`: repositorio objetivo determinista del E2E.

## Límites de seguridad

- El navegador sólo recibe variables `NEXT_PUBLIC_*` y una clave pública de ingestión.
- Las claves de OpenAI/GitHub, base de datos, S3 y operación interna son server-only.
- CORS, rate limit, schemas estrictos, límite de 5 MB, verificación MIME y firma HMAC de webhooks están activos.
- El agente no recibe shell arbitrario, no puede escapar del workspace y el diff se revisa contra patrones de secretos.
- Un caso ambiguo o no reproducible termina en `needs_human_review`.
- No hay endpoint ni código de merge automático.

