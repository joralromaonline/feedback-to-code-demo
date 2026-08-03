import type { Metadata } from "next";
import "@feedback-code/next/styles.css";
import "./globals.css";
import { FeedbackDemoProvider } from "../components/feedback-demo-provider";

export const metadata: Metadata = {
  title: "Checkout demo · Feedback-to-Code",
  description: "Demo end-to-end del SDK Feedback-to-Code"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        <FeedbackDemoProvider>{children}</FeedbackDemoProvider>
      </body>
    </html>
  );
}
