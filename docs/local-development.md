# Desarrollo local y operación

## Arranque limpio

```bash
cp .env.example .env
pnpm install
pnpm docker:up
```

`docker:up` construye y levanta PostgreSQL, Redis, MinIO, la migración, Fastify, el worker y la demo Next.js. La API siembra el proyecto demo guardando únicamente el hash SHA-256 de la clave pública.

Comprueba el entorno:

```bash
curl http://localhost:3001/healthz
pnpm demo:flow
RUN_DOCKER_E2E=true pnpm test:e2e
```

La salud completa requiere el token interno:

```bash
curl http://localhost:3001/internal/health \
  -H "authorization: Bearer $INTERNAL_SERVICE_TOKEN"
```

## Variables

| Variable | Uso | Exposición |
|---|---|---|
| `PUBLIC_DEMO_PROJECT_KEY` | Autorización limitada de ingestión | Pública |
| `NEXT_PUBLIC_FEEDBACK_*` | Configuración del SDK demo | Pública |
| `DATABASE_URL`, `REDIS_URL`, `S3_*` | Persistencia, cola y screenshots | Servidor |
| `INTERNAL_SERVICE_TOKEN` | Endpoints operativos | Servidor |
| `LLM_PROVIDER`, `OPENAI_*`, `NVIDIA_*` | Clasificación y agente | Servidor/worker |
| `GITHUB_*` | GitHub App y webhook | Servidor/worker |

La API valida todas las variables al iniciar. En `mock`, LLM y GitHub pueden estar vacías; en `real`, exige GitHub y sólo las credenciales del `LLM_PROVIDER` seleccionado.

## Endpoints operativos

Todos requieren `Authorization: Bearer $INTERNAL_SERVICE_TOKEN`.

```text
GET    /internal/health
GET    /internal/jobs/:feedbackId
GET    /internal/metrics
POST   /internal/feedback/:feedbackId/retry
POST   /internal/feedback/:feedbackId/cancel
DELETE /internal/feedback/:feedbackId
```

El borrado elimina primero screenshots de S3/MinIO y luego la fila de feedback; las relaciones de runs, eventos y PR usan borrado en cascada. Los webhooks se deduplican mediante `X-GitHub-Delivery`.

## Ejecución sin Docker para la aplicación

Mantén PostgreSQL, Redis y MinIO activos y ejecuta procesos separados:

```bash
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
pnpm dev:demo
```

## Diagnóstico

```bash
pnpm docker:logs
docker-compose ps
```

- `classification_failed`: la salida estructurada no fue válida tras los reintentos.
- `needs_human_review`: el feedback es ambiguo, no reproducible o el agente se detuvo de forma segura.
- `failed`: el job puede reintentarse; la cola conserva backoff e idempotencia.
- Screenshot `failed`: el texto continúa por el flujo y el evento registra un mensaje seguro.

Los comandos ausentes en el repositorio objetivo aparecen como `not_configured`; no se reportan como ejecutados.
