// app/layout.tsx —— 根布局：顶栏（品牌 + 桌面导航）+ 移动端底部 tab（NavBar 内分档渲染），
// 移动端 main 预留 pb-20 给底部 tab，桌面端限宽 max-w-4xl 居中。
import type { Metadata } from "next";
import type { ReactNode } from "react";
import NavBar from "../components/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent 工作台",
  description: "智能对话 · 知识库管理 · 智能客服（Next.js 前端消费自研 BFF API）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col bg-gray-50 font-sans text-gray-900 antialiased">
        <header className="sticky top-0 z-40 border-b border-gray-200 bg-white">
          <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between px-4">
            <span className="text-base font-bold tracking-tight">🤖 Agent 工作台</span>
            <NavBar />
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 pb-20 md:pb-8">
          {children}
        </main>
      </body>
    </html>
  );
}
