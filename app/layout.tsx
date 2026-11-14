import type { Metadata } from "next";
import TechnicalErrorCapture from "@/components/dota/technical-error-capture";
import "./globals.css";
export const metadata: Metadata = {
  title: "Dota Lab — журнал прогнозов",
  description: "Прогнозы Dota 2, реальные результаты и проверка вероятностей в одном журнале.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body><TechnicalErrorCapture />{children}</body></html>;
}
