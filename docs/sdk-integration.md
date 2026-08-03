# Integración del SDK

## App Router

Importa los estilos una vez en `app/layout.tsx` y envuelve la aplicación con un Client Component.

```tsx
// app/feedback-provider.tsx
"use client";

import type { ReactNode } from "react";
import { FeedbackProvider } from "@feedback-code/next/react";

export function AppFeedbackProvider({ children }: { children: ReactNode }) {
  return (
    <FeedbackProvider
      projectKey={process.env.NEXT_PUBLIC_FEEDBACK_PROJECT_KEY!}
      apiUrl={process.env.NEXT_PUBLIC_FEEDBACK_API_URL!}
      environment="staging"
      enabled={process.env.NEXT_PUBLIC_FEEDBACK_ENABLED === "true"}
      appRevision={process.env.NEXT_PUBLIC_APP_REVISION}
      redactSelectors={["input", "textarea", "[data-sensitive]"]}
    >
      {children}
    </FeedbackProvider>
  );
}
```

```tsx
// app/layout.tsx
import "@feedback-code/next/styles.css";
import { AppFeedbackProvider } from "./feedback-provider";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><AppFeedbackProvider>{children}</AppFeedbackProvider></body></html>;
}
```

## Pages Router

Usa el mismo provider en `pages/_app.tsx`:

```tsx
import type { AppProps } from "next/app";
import "@feedback-code/next/styles.css";
import { FeedbackProvider } from "@feedback-code/next/react";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <FeedbackProvider
      projectKey={process.env.NEXT_PUBLIC_FEEDBACK_PROJECT_KEY!}
      apiUrl={process.env.NEXT_PUBLIC_FEEDBACK_API_URL!}
      environment="development"
      enabled={process.env.NEXT_PUBLIC_FEEDBACK_ENABLED === "true"}
    >
      <Component {...pageProps} />
    </FeedbackProvider>
  );
}
```

## Contratos del DOM

- `data-feedback-id="checkout-submit"`: identificador estable preferido por el agente.
- `data-feedback-ignore`: excluye un nodo de selección y screenshot.
- `data-feedback-redact` o `data-sensitive`: oculta texto en la captura.
- Inputs y textareas se redactan por defecto.

El atajo `Ctrl/Cmd + Shift + F` activa la selección. `Esc` la cancela. La captura usa `html2canvas` de forma lazy, WebP con calidad 0.82, escala máxima 2x y límite de 5 MB.

Si la captura falla, el comentario y metadatos se envían sin imagen. Si la API falla, se hace un único reintento con el mismo UUID/`Idempotency-Key` y el borrador permanece en `localStorage`.

Sólo estas variables deben llegar al bundle:

```dotenv
NEXT_PUBLIC_FEEDBACK_API_URL=https://feedback.example.com
NEXT_PUBLIC_FEEDBACK_PROJECT_KEY=pk_public_ingest_key
NEXT_PUBLIC_FEEDBACK_ENVIRONMENT=staging
NEXT_PUBLIC_FEEDBACK_ENABLED=true
NEXT_PUBLIC_APP_REVISION=git-sha
```

Nunca uses prefijo `NEXT_PUBLIC_` para OpenAI, GitHub, base de datos, S3 o `INTERNAL_SERVICE_TOKEN`.

