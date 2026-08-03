# Integraciones reales: GitHub App y OpenAI

## GitHub App

Crea una GitHub App e instálala únicamente en los repositorios autorizados.

Permisos mínimos del repositorio:

- Metadata: read.
- Contents: read/write.
- Issues: read/write.
- Pull requests: read/write.

Configura el webhook en:

```text
https://TU_API_PUBLICA/v1/webhooks/github
```

Suscribe el evento `Pull requests` y usa un secreto aleatorio fuerte. La API verifica `X-Hub-Signature-256` antes de procesar el JSON y deduplica cada entrega por `X-GitHub-Delivery`.

Convierte la clave PEM a una sola línea base64:

```bash
base64 < github-app-private-key.pem | tr -d '\n'
```

Configura en `.env`:

```dotenv
INTEGRATION_MODE=real
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_BASE64=BASE64_DEL_PEM
GITHUB_WEBHOOK_SECRET=SECRETO_ALEATORIO
GITHUB_INSTALLATION_ID=12345678
GITHUB_OWNER=organizacion
GITHUB_REPO=repositorio
GITHUB_BASE_BRANCH=main
PUBLIC_API_ORIGIN=https://TU_API_PUBLICA
```

El worker obtiene installation tokens temporales en servidor, los pasa a Git mediante un header de entorno y nunca los incluye en argumentos, prompts, Issues o PRs. Sólo permite ramas `feedback/*`; no hace merge ni push a `main`.

## OpenAI

Configura una API key de proyecto únicamente en API/worker:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6
OPENAI_TIMEOUT_MS=120000
OPENAI_MAX_AGENT_TURNS=40
OPENAI_REASONING_EFFORT=medium
```

La integración usa Responses API para clasificación estructurada y para el loop de herramientas. `OPENAI_MODEL` permanece configurable. Las respuestas se ejecutan con `store: false`; el modelo sólo ve feedback sin `projectKey`/screenshot, instrucciones del repositorio limitadas y herramientas tipadas.

## Prueba controlada del modo real

1. Usa un repositorio sandbox y una rama base protegida.
2. Expón API y webhook mediante HTTPS; ajusta `PUBLIC_API_ORIGIN` y `CORS_ORIGINS`.
3. Completa las variables anteriores y ejecuta `pnpm docker:up`.
4. Envía feedback desde la demo o con `pnpm demo:flow`.
5. Revisa Issue, rama `feedback/*`, diff, `validation-report.json` y PR.
6. No hagas merge hasta verificar manualmente permisos, evidencia y alcance.

