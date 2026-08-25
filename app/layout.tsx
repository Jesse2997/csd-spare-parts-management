import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CSD 備品管理系統",
  description: "私人雲端備品規劃、RMA、庫存與版本化資料匯入系統",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
